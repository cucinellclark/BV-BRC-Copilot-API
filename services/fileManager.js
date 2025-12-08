// services/fileManager.js

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  normalizeToolResult,
  createSummary,
  formatSize
} = require('./fileUtils');

/**
 * FileManager - Handles storage and retrieval of large tool results
 */
class FileManager {
  constructor(baseDir = '/tmp/copilot', options = {}) {
    this.baseDir = baseDir;
    this.inlineSizeThreshold = 2000; // 2KB - results smaller than this are returned inline
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
   * Process and potentially save a tool result
   * Returns either inline data or a file reference
   */
  async processToolResult(sessionId, toolId, result) {
    try {
      // Serialize result to check size
      const resultStr = JSON.stringify(result);
      const size = Buffer.byteLength(resultStr, 'utf8');

      console.log(`[FileManager] Processing result from ${toolId}: ${formatSize(size)}`);

      // If small enough, return inline
      if (size < this.inlineSizeThreshold) {
        console.log(`[FileManager] Result is small (${formatSize(size)}), returning inline`);
        return {
          type: 'inline',
          data: result
        };
      }

      // Large result - save to file
      console.log(`[FileManager] Result is large (${formatSize(size)}), saving to file`);
      return await this.saveToolResult(sessionId, toolId, result, resultStr, size);
    } catch (error) {
      console.error('[FileManager] Error processing tool result:', error);
      // On error, fall back to returning inline (truncated if necessary)
      return {
        type: 'inline',
        data: result,
        error: `Failed to save to file: ${error.message}`
      };
    }
  }

  /**
   * Save a tool result to disk and return a file reference
   * Automatically normalizes API-specific formats (e.g., BV-BRC)
   */
  async saveToolResult(sessionId, toolId, result, resultStr, size) {
    // Create session directories
    const downloadsDir = this.getDownloadsDir(sessionId);
    await fs.mkdir(downloadsDir, { recursive: true });

    // Generate unique file ID and name
    const fileId = crypto.randomUUID();
    const sanitizedToolId = toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${sanitizedToolId}_${fileId.substring(0, 8)}.json`;
    const filePath = path.join(downloadsDir, fileName);

    // Normalize the result - handles API-specific formats
    const normalized = normalizeToolResult(result);
    
    // Create summary from normalized data
    const summary = createSummary(normalized, size);
    
    // Save the normalized data (unwrapped if applicable)
    const dataToSave = JSON.stringify(normalized.data);
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

    await this.updateMetadata(sessionId, metadata);

    // Return file reference
    return {
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
      return {
        fileInfo,
        content,
        parsed: JSON.parse(content) // Assume JSON for now
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
}

// Singleton instance
const fileManager = new FileManager();

module.exports = {
  FileManager,
  fileManager
};

