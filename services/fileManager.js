// services/fileManager.js

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  normalizeToolResult,
  createSummary,
  formatSize
} = require('./fileUtils');
const { workspaceService } = require('./workspaceService');

/**
 * FileManager - Handles storage and retrieval of large tool results
 */
class FileManager {
  constructor(baseDir = '/tmp/copilot', options = {}) {
    this.baseDir = baseDir;
    // Read thresholds from config.json
    const defaultAccumulateThreshold = 10 * 1024 * 1024; // 10MB
    const defaultMaxPages = 100;
    
    let accumulateThreshold = defaultAccumulateThreshold;
    let maxPages = defaultMaxPages;
    let uploadToWorkspace = false;
    let workspaceUploadDir = 'CopilotDownloads';
    
    try {
      const config = require('../config.json');
      if (config.fileManager?.accumulateSizeThreshold !== undefined) {
        accumulateThreshold = config.fileManager.accumulateSizeThreshold;
      }
      if (config.fileManager?.maxAccumulatePages !== undefined) {
        maxPages = config.fileManager.maxAccumulatePages;
      }
      if (config.fileManager?.uploadToWorkspace !== undefined) {
        uploadToWorkspace = config.fileManager.uploadToWorkspace;
      }
      if (config.fileManager?.workspaceUploadDir !== undefined) {
        workspaceUploadDir = config.fileManager.workspaceUploadDir;
      }
    } catch (error) {
      // Config file doesn't exist or can't be loaded, use defaults
    }
    
    this.accumulateSizeThreshold = accumulateThreshold;
    this.maxAccumulatePages = maxPages;
    this.uploadToWorkspace = uploadToWorkspace;
    this.workspaceUploadDir = workspaceUploadDir;
    this.maxSessionSize = 500 * 1024 * 1024; // 500MB per session
    this.useDatabase = options.useDatabase !== undefined ? options.useDatabase : true; // Default to MongoDB
    
    // Import dbUtils only if using database
    if (this.useDatabase) {
      this.dbUtils = require('./dbUtils');
    }
  }

  /**
   * Initialize the file manager (create base directory)
   */
  async init() {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.mkdir(path.join(this.baseDir, 'sessions'), { recursive: true });
      console.log(`[FileManager] Initialized at ${this.baseDir}`);
    } catch (error) {
      console.error('[FileManager] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Get the session directory path
   */
  getSessionDir(sessionId) {
    return path.join(this.baseDir, 'sessions', sessionId);
  }

  /**
   * Get the downloads directory for a session
   */
  getDownloadsDir(sessionId) {
    return path.join(this.getSessionDir(sessionId), 'downloads');
  }

  /**
   * Get the metadata file path for a session
   */
  getMetadataPath(sessionId) {
    return path.join(this.getSessionDir(sessionId), 'metadata.json');
  }

  /**
   * Process and save a tool result to file
   * Always saves to file (Tier 2: accumulate then save, or Tier 3: stream to file)
   * Returns a file reference
   * 
   * @param {string} sessionId - Session ID
   * @param {string} toolId - Tool ID
   * @param {any} result - Tool execution result
   * @param {object} context - Optional context with authToken and user_id for workspace upload
   * @param {number} estimatedPages - Optional estimated number of pages (for streaming decision)
   */
  async processToolResult(sessionId, toolId, result, context = {}, estimatedPages = null) {
    try {
      // Serialize result to check size
      const resultStr = JSON.stringify(result);
      const size = Buffer.byteLength(resultStr, 'utf8');

      console.log(`[FileManager] Processing result from ${toolId}: ${formatSize(size)}`);

      // Always save to file - no inline results
      // Determine if we should use Tier 2 (accumulate) or Tier 3 (stream to file)
      const shouldStream = size >= this.accumulateSizeThreshold || 
                          (estimatedPages !== null && estimatedPages > this.maxAccumulatePages);

      if (shouldStream) {
        console.log(`[FileManager] Result exceeds threshold (${formatSize(size)}), will stream to file`);
        // For now, still use saveToolResult (Tier 3 streaming implementation will come later)
        // This maintains current behavior while preparing for streaming
      } else {
        console.log(`[FileManager] Result size (${formatSize(size)}), saving to file`);
      }

      return await this.saveToolResult(sessionId, toolId, result, resultStr, size, context);
    } catch (error) {
      console.error('[FileManager] Error processing tool result:', error);
      // On error, still try to save (don't return inline)
      // Re-throw to let caller handle the error appropriately
      throw new Error(`Failed to save tool result to file: ${error.message}`);
    }
  }

  /**
   * Save a tool result to disk and return a file reference
   * Automatically normalizes API-specific formats (e.g., BV-BRC)
   * Optionally uploads to BV-BRC workspace
   * 
   * @param {string} sessionId - Session ID
   * @param {string} toolId - Tool ID
   * @param {any} result - Tool execution result
   * @param {string} resultStr - Serialized result
   * @param {number} size - Size in bytes
   * @param {object} context - Context with authToken and user_id for workspace upload
   */
  async saveToolResult(sessionId, toolId, result, resultStr, size, context = {}) {
    // Create session directories
    const downloadsDir = this.getDownloadsDir(sessionId);
    await fs.mkdir(downloadsDir, { recursive: true });

    // Normalize the result - handles API-specific formats
    const normalized = normalizeToolResult(result);

    // Generate unique file ID and name
    const fileId = crypto.randomUUID();
    const sanitizedToolId = toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const extension = this.getFileExtension(normalized.dataType);
    const fileName = `${sanitizedToolId}_${fileId.substring(0, 8)}.${extension}`;
    const filePath = path.join(downloadsDir, fileName);
    
    // Create summary from normalized data
    const summary = createSummary(normalized, size);
    
    // Save the normalized data (unwrapped if applicable)
    const dataToSave = this.serializeForStorage(normalized.data, normalized.dataType);
    await fs.writeFile(filePath, dataToSave, 'utf8');
    
    if (normalized.metadata) {
      console.log(`[FileManager] Saved normalized ${normalized.metadata.source} data to ${filePath} (${summary.recordCount} records)`);
    } else {
      console.log(`[FileManager] Saved to ${filePath}`);
    }

    // Update metadata
    const metadata = {
      fileId,
      fileName,
      filePath,
      toolId,
      dataType: normalized.dataType,
      size,
      recordCount: summary.recordCount,
      fields: summary.fields,
      created: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    };
    
    // Add query parameters from normalized metadata if present (for query_collection tools)
    if (normalized.metadata && normalized.metadata.queryParameters) {
      metadata.queryParameters = normalized.metadata.queryParameters;
      console.log(`[FileManager] Added query parameters to metadata`, {
        toolId,
        queryParameters: Object.keys(normalized.metadata.queryParameters)
      });
    }

    // Upload to workspace if enabled
    // This ensures all files saved to /tmp are automatically uploaded to workspace
    let workspaceInfo = null;
    if (this.uploadToWorkspace) {
      if (context.authToken && context.user_id) {
        try {
          // Extract userId from token (may include domain like user@domain.com)
          // Use token-extracted userId as it's the authoritative source
          const userId = workspaceService.extractUserId(context.authToken) || context.user_id;
          
          console.log(`[FileManager] Auto-uploading file to workspace`, {
            fileName,
            filePath,
            fileSize: formatSize(size),
            contextUserId: context.user_id,
            tokenExtractedUserId: workspaceService.extractUserId(context.authToken),
            usingUserId: userId
          });
          
          // Resolve workspace directory path using token-extracted userId
          // Organize by session: CopilotDownloads/{sessionId}/
          const sessionUploadDir = `${this.workspaceUploadDir}/${sessionId}`;
          const uploadDir = workspaceService.resolveWorkspacePath(
            sessionUploadDir,
            userId
          );
          
          console.log(`[FileManager] Uploading to session-specific folder`, {
            sessionId,
            sessionUploadDir,
            resolvedUploadDir: uploadDir
          });
          
          // Upload file to workspace
          const uploadResult = await workspaceService.uploadFile(
            filePath,
            uploadDir,
            context.authToken,
            sessionId
          );
          
          if (uploadResult.success) {
            // Generate workspace directory URL
            const workspaceUrl = workspaceService.getWorkspaceDirectoryUrl(uploadResult.workspacePath);
            
            workspaceInfo = {
              workspacePath: uploadResult.workspacePath,
              workspaceUrl: workspaceUrl,
              uploadedAt: new Date().toISOString()
            };
            metadata.workspacePath = uploadResult.workspacePath;
            metadata.workspaceUrl = workspaceUrl;
            metadata.workspaceUploadedAt = workspaceInfo.uploadedAt;
            
            console.log(`[FileManager] Successfully uploaded to workspace: ${uploadResult.workspacePath}`, {
              fileName,
              duration: `${uploadResult.duration}ms`,
              uploadSpeed: uploadResult.uploadSpeed ? `${uploadResult.uploadSpeed.toFixed(2)} MB/s` : 'N/A'
            });
          } else {
            console.warn(`[FileManager] Workspace upload failed: ${uploadResult.error}`, {
              fileName,
              filePath
            });
            metadata.workspaceUploadError = uploadResult.error;
          }
        } catch (error) {
          console.error(`[FileManager] Workspace upload error:`, {
            fileName,
            filePath,
            error: error.message,
            stack: error.stack
          });
          metadata.workspaceUploadError = error.message;
          // Don't fail the entire operation if workspace upload fails
        }
      } else {
        // Log when upload is skipped due to missing auth
        const missingAuth = [];
        if (!context.authToken) missingAuth.push('authToken');
        if (!context.user_id) missingAuth.push('user_id');
        console.warn(`[FileManager] Workspace upload skipped - missing authentication: ${missingAuth.join(', ')}`, {
          fileName,
          filePath,
          hasAuthToken: !!context.authToken,
          hasUserId: !!context.user_id
        });
        metadata.workspaceUploadSkipped = `Missing: ${missingAuth.join(', ')}`;
      }
    }

    await this.updateMetadata(sessionId, metadata);

    // Return file reference
    const fileReference = {
      type: 'file_reference',
      fileId,
      fileName,
      filePath,
      summary: {
        dataType: normalized.dataType,
        size,
        sizeFormatted: formatSize(size),
        recordCount: summary.recordCount,
        fields: summary.fields,
        sampleRecord: summary.sampleRecord
      },
      message: `Large result saved to file (${formatSize(size)}, ${summary.recordCount} records)`
    };

    // Add query parameters to file reference if present (for query_collection tools)
    if (normalized.metadata && normalized.metadata.queryParameters) {
      fileReference.queryParameters = normalized.metadata.queryParameters;
    }

    // Add workspace info if uploaded
    if (workspaceInfo) {
      fileReference.workspace = workspaceInfo;
      fileReference.message += ` and uploaded to workspace at ${workspaceInfo.workspacePath}`;
    }

    return fileReference;
  }


  /**
   * Update session metadata with new file info
   */
  async updateMetadata(sessionId, fileInfo) {
    if (this.useDatabase) {
      // Store in MongoDB
      try {
        await this.dbUtils.saveFileMetadata(sessionId, fileInfo);
        
        // Check session size limit
        const totalSize = await this.dbUtils.getSessionStorageSize(sessionId);
        if (totalSize > this.maxSessionSize) {
          console.warn(`[FileManager] Session ${sessionId} has exceeded size limit: ${formatSize(totalSize)}`);
        }
        
        console.log(`[FileManager] Updated metadata in database for session ${sessionId}`);
      } catch (error) {
        console.error(`[FileManager] Failed to save metadata to database:`, error);
        // Fall back to JSON file on error
        await this.updateMetadataFile(sessionId, fileInfo);
      }
    } else {
      // Store in JSON file
      await this.updateMetadataFile(sessionId, fileInfo);
    }
  }

  /**
   * Update session metadata file (fallback or when useDatabase=false)
   */
  async updateMetadataFile(sessionId, fileInfo) {
    const metadataPath = this.getMetadataPath(sessionId);
    let metadata = {
      session_id: sessionId,
      created: new Date().toISOString(),
      files: [],
      totalSize: 0
    };

    // Load existing metadata if it exists
    try {
      const existing = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(existing);
    } catch (err) {
      // File doesn't exist yet, use default
      console.log(`[FileManager] Creating new metadata file for session ${sessionId}`);
    }

    // Add new file
    metadata.files.push(fileInfo);
    metadata.totalSize += fileInfo.size;
    metadata.lastUpdated = new Date().toISOString();

    // Check session size limit
    if (metadata.totalSize > this.maxSessionSize) {
      console.warn(`[FileManager] Session ${sessionId} has exceeded size limit: ${formatSize(metadata.totalSize)}`);
    }

    // Write updated metadata
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`[FileManager] Updated metadata file for session ${sessionId}`);
  }

  /**
   * Get metadata for a session
   */
  async getSessionMetadata(sessionId) {
    if (this.useDatabase) {
      try {
        const files = await this.dbUtils.getSessionFiles(sessionId);
        if (!files || files.length === 0) {
          return null;
        }
        
        const totalSize = await this.dbUtils.getSessionStorageSize(sessionId);
        return {
          session_id: sessionId,
          files: files,
          totalSize: totalSize
        };
      } catch (error) {
        console.error(`[FileManager] Error getting metadata from database:`, error);
        // Fall back to JSON file
        return await this.getSessionMetadataFile(sessionId);
      }
    } else {
      return await this.getSessionMetadataFile(sessionId);
    }
  }

  /**
   * Get metadata from JSON file (fallback or when useDatabase=false)
   */
  async getSessionMetadataFile(sessionId) {
    try {
      const metadataPath = this.getMetadataPath(sessionId);
      const data = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // No metadata yet
      }
      throw error;
    }
  }

  /**
   * Get file info by fileId
   */
  async getFileInfo(sessionId, fileId) {
    if (this.useDatabase) {
      try {
        const fileInfo = await this.dbUtils.getFileMetadata(sessionId, fileId);
        if (!fileInfo) {
          throw new Error(`File ${fileId} not found in session ${sessionId}`);
        }
        return fileInfo;
      } catch (error) {
        console.error(`[FileManager] Error getting file info from database:`, error);
        // Fall back to JSON file
        return await this.getFileInfoFromFile(sessionId, fileId);
      }
    } else {
      return await this.getFileInfoFromFile(sessionId, fileId);
    }
  }

  /**
   * Get file info from JSON file (fallback or when useDatabase=false)
   */
  async getFileInfoFromFile(sessionId, fileId) {
    const metadata = await this.getSessionMetadataFile(sessionId);
    if (!metadata) {
      throw new Error(`No metadata found for session ${sessionId}`);
    }

    const fileInfo = metadata.files.find(f => f.fileId === fileId);
    if (!fileInfo) {
      throw new Error(`File ${fileId} not found in session ${sessionId}`);
    }

    // Update last accessed time
    fileInfo.lastAccessed = new Date().toISOString();
    const metadataPath = this.getMetadataPath(sessionId);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    return fileInfo;
  }

  /**
   * Load file content by fileId
   */
  async loadFile(sessionId, fileId) {
    const fileInfo = await this.getFileInfo(sessionId, fileId);
    
    try {
      const content = await fs.readFile(fileInfo.filePath, 'utf8');
      let parsed = null;

      // Only attempt JSON parse for JSON-like data
      if (['json_array', 'json_object', 'array', 'object', 'null', 'empty_array'].includes(fileInfo.dataType)) {
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          console.warn(`[FileManager] Failed to parse JSON for file ${fileId}:`, err.message);
        }
      }

      return {
        fileInfo,
        content,
        parsed
      };
    } catch (error) {
      console.error(`[FileManager] Error loading file ${fileId}:`, error);
      throw error;
    }
  }

  /**
   * Check if session directory exists
   */
  async sessionExists(sessionId) {
    try {
      await fs.access(this.getSessionDir(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get total size of all files in a session
   */
  async getSessionSize(sessionId) {
    const metadata = await getSessionMetadata(sessionId);
    return metadata ? metadata.totalSize : 0;
  }

  /**
   * Choose an extension based on detected data type
   */
  getFileExtension(dataType) {
    switch (dataType) {
      case 'csv':
        return 'csv';
      case 'tsv':
        return 'tsv';
      case 'text':
        return 'txt';
      default:
        return 'json';
    }
  }

  /**
   * Recursively parse JSON strings in 'text' fields
   * This handles FastMCP format where data is wrapped as { type: "text", text: "..." }
   */
  parseNestedJsonStrings(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // If it's an array, process each element
    if (Array.isArray(obj)) {
      return obj.map(item => this.parseNestedJsonStrings(item));
    }

    // If it's an object, check for 'text' field with JSON string
    if (typeof obj === 'object') {
      const parsed = {};
      for (const [key, value] of Object.entries(obj)) {
        // If this is a 'text' field and it's a string that looks like JSON, parse it
        if (key === 'text' && typeof value === 'string') {
          const trimmed = value.trim();
          // Check if it looks like JSON (starts with { or [)
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsedValue = JSON.parse(value);
              // Recursively parse the parsed JSON in case it has nested text fields
              parsed[key] = this.parseNestedJsonStrings(parsedValue);
            } catch (e) {
              // Not valid JSON, keep as string
              parsed[key] = value;
            }
          } else {
            // Not JSON-like, keep as string
            parsed[key] = value;
          }
        } else {
          // Recursively process nested objects/arrays
          parsed[key] = this.parseNestedJsonStrings(value);
        }
      }
      return parsed;
    }

    // Primitive value, return as-is
    return obj;
  }

  /**
   * Serialize data for storage based on type
   */
  serializeForStorage(data, dataType) {
    // Parse nested JSON strings in text fields before serialization
    const parsedData = this.parseNestedJsonStrings(data);
    
    if (dataType === 'text' || dataType === 'csv' || dataType === 'tsv') {
      return typeof parsedData === 'string' ? parsedData : String(parsedData);
    }
    // Default to JSON for structured types
    return JSON.stringify(parsedData, null, 2);
  }
}

// Singleton instance
const fileManager = new FileManager();

module.exports = {
  FileManager,
  fileManager
};

