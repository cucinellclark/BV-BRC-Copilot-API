// services/workspaceService.js

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

/**
 * WorkspaceService - Direct client for BV-BRC Workspace API
 * Handles file uploads without going through MCP server
 */
class WorkspaceService {
  constructor(workspaceUrl = 'https://p3.theseed.org/services/Workspace') {
    this.workspaceUrl = workspaceUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Extract user ID from BV-BRC auth token
   */
  extractUserId(token) {
    if (!token) return null;
    
    try {
      // Token format: "un=username|..." or "Bearer un=username|..."
      const tokenStr = token.replace(/^Bearer\s+/i, '');
      const userIdMatch = tokenStr.match(/un=([^|]+)/);
      const userId = userIdMatch ? userIdMatch[1] : null;
      
      if (userId) {
        console.log(`[WorkspaceService] Extracted user ID from token: ${userId}`);
      } else {
        console.warn('[WorkspaceService] Failed to extract user ID from token');
      }
      
      return userId;
    } catch (error) {
      console.error('[WorkspaceService] Error extracting user ID:', error.message);
      return null;
    }
  }

  /**
   * Get user's home path in workspace
   */
  getUserHomePath(userId) {
    return userId ? `/${userId}/home` : '/';
  }

  /**
   * Get workspace file type from file extension
   * Maps common file extensions to workspace-recognized file types
   * 
   * @param {string} filePath - Path to the file
   * @returns {string} Workspace file type (e.g., 'csv', 'tsv', 'json', 'fasta', 'gff', etc.)
   */
  getWorkspaceFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    
    // Map extensions to workspace file types
    const extensionToType = {
      // Tabular data
      'csv': 'csv',
      'tsv': 'tsv',
      'txt': 'txt',
      
      // JSON data
      'json': 'json',
      'jsonl': 'json',
      
      // Sequence data
      'fasta': 'contigs',
      'fa': 'contigs',  // Changed from 'fasta' to 'contigs' for BV-BRC workspace compatibility
      'fna': 'contigs',
      'faa': 'contigs',
      'ffn': 'contigs',
      'frn': 'contigs',
      'fastq': 'reads',
      'fq': 'reads',
      'fastq.gz': 'reads',
      'fq.gz': 'reads',
      
      // Annotation data
      'gff': 'gff',
      'gff3': 'gff3',
      'gtf': 'gtf',
      'gb': 'genbank',
      'gbk': 'genbank',
      'genbank': 'genbank',
      'embl': 'embl',
      
      // Alignment data
      'sam': 'sam',
      'bam': 'bam',
      'vcf': 'vcf',
      'bed': 'bed',
      'wig': 'wig',
      'bigwig': 'bigwig',
      
      // Other common formats
      'xml': 'xml',
      'html': 'html',
      'htm': 'html',
      'pdf': 'pdf',
      'zip': 'zip',
      'gz': 'gzip',
      'tar': 'tar',
      'xlsx': 'excel',
      'xls': 'excel',
      'odt': 'odt',
      'ods': 'ods'
    };
    
    const fileType = extensionToType[ext] || 'unspecified';
    
    if (fileType !== 'unspecified') {
      console.log(`[WorkspaceService] Detected file type: ${fileType} for extension: .${ext}`);
    } else {
      console.log(`[WorkspaceService] Unknown file extension: .${ext}, using 'unspecified' type`);
    }
    
    return fileType;
  }

  /**
   * Get MIME type from file extension
   * Used for proper content-type headers during file upload
   * 
   * @param {string} filePath - Path to the file
   * @returns {string} MIME type (e.g., 'text/csv', 'application/json', etc.)
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    
    // Map extensions to MIME types
    const extensionToMime = {
      // Tabular data
      'csv': 'text/csv',
      'tsv': 'text/tab-separated-values',
      'txt': 'text/plain',
      
      // JSON data
      'json': 'application/json',
      'jsonl': 'application/jsonl',
      
      // Sequence data
      'fasta': 'text/x-fasta',
      'fa': 'text/x-fasta',
      'fna': 'text/x-fasta',
      'faa': 'text/x-fasta',
      'ffn': 'text/x-fasta',
      'frn': 'text/x-fasta',
      'fastq': 'text/x-fastq',
      'fq': 'text/x-fastq',
      
      // Annotation data
      'gff': 'text/x-gff',
      'gff3': 'text/x-gff3',
      'gtf': 'text/x-gtf',
      'gb': 'text/x-genbank',
      'gbk': 'text/x-genbank',
      'genbank': 'text/x-genbank',
      'embl': 'text/x-embl',
      
      // Alignment data
      'sam': 'text/x-sam',
      'bam': 'application/x-bam',
      'vcf': 'text/x-vcf',
      'bed': 'text/x-bed',
      'wig': 'text/x-wig',
      
      // Other common formats
      'xml': 'application/xml',
      'html': 'text/html',
      'htm': 'text/html',
      'pdf': 'application/pdf',
      'zip': 'application/zip',
      'gz': 'application/gzip',
      'tar': 'application/x-tar',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'odt': 'application/vnd.oasis.opendocument.text',
      'ods': 'application/vnd.oasis.opendocument.spreadsheet'
    };
    
    const mimeType = extensionToMime[ext] || 'application/octet-stream';
    
    if (mimeType !== 'application/octet-stream') {
      console.log(`[WorkspaceService] Detected MIME type: ${mimeType} for extension: .${ext}`);
    }
    
    return mimeType;
  }

  /**
   * Make a JSON-RPC call to workspace API
   */
  async jsonRpcCall(method, params, token, sessionId = null) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now()
    };

    const headers = {
      'Content-Type': 'application/jsonrpc+json'
    };

    if (token) {
      // Remove Bearer prefix if present, workspace expects raw token
      const cleanToken = token.replace(/^Bearer\s+/i, '');
      headers['Authorization'] = cleanToken;
    }

    console.log(`[WorkspaceService] Making JSON-RPC call: ${method}`, {
      url: this.workspaceUrl,
      hasToken: !!token,
      sessionId: sessionId || 'none'
    });

    try {
      const startTime = Date.now();
      const response = await axios.post(this.workspaceUrl, payload, {
        headers,
        timeout: 30000
      });
      const duration = Date.now() - startTime;

      if (response.data.error) {
        console.error(`[WorkspaceService] Workspace API returned error for ${method}:`, {
          error: response.data.error,
          duration: `${duration}ms`
        });
        throw new Error(`Workspace API error: ${JSON.stringify(response.data.error)}`);
      }

      console.log(`[WorkspaceService] Workspace API call successful: ${method}`, {
        duration: `${duration}ms`,
        hasResult: !!response.data.result
      });

      return response.data.result;
    } catch (error) {
      if (error.response) {
        // Properly stringify error data for better error messages
        const errorData = error.response.data;
        const errorMessage = typeof errorData === 'object' && errorData !== null
          ? JSON.stringify(errorData)
          : String(errorData);
        
        console.error(`[WorkspaceService] Workspace API call failed: ${method}`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: errorData,
          url: this.workspaceUrl
        });
        throw new Error(`Workspace API failed: ${error.response.status} - ${errorMessage}`);
      }
      console.error(`[WorkspaceService] Workspace API call error: ${method}`, {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Ensure workspace directory exists
   */
  async ensureDirectoryExists(dirPath, token, sessionId = null) {
    try {
      // Try to create the directory (will succeed if it exists or is created)
      await this.jsonRpcCall(
        'Workspace.create',
        {
          objects: [[dirPath, 'folder', {}, '']],
          createUploadNodes: false,
          overwrite: false
        },
        token,
        sessionId
      );
      console.log(`[WorkspaceService] Directory ensured: ${dirPath}`);
    } catch (error) {
      // Directory might already exist, which is fine
      // Only log if it's not a "already exists" type error
      if (!error.message.includes('already exists') && !error.message.includes('exists')) {
        console.warn(`[WorkspaceService] Could not ensure directory exists: ${dirPath}`, {
          error: error.message
        });
      }
    }
  }

  /**
   * Create workspace object and get upload URL
   */
  async createUploadNode(filePath, uploadDir, token, sessionId = null) {
    const fileName = path.basename(filePath);
    const workspacePath = path.join(uploadDir, fileName).replace(/\\/g, '/');
    
    // Determine file type from extension
    const fileType = this.getWorkspaceFileType(filePath);

    console.log(`[WorkspaceService] Creating workspace upload node`, {
      fileName,
      workspacePath,
      uploadDir,
      fileType,
      sessionId: sessionId || 'none'
    });

    try {
      // Ensure the directory exists first
      await this.ensureDirectoryExists(uploadDir, token, sessionId);

      const result = await this.jsonRpcCall(
        'Workspace.create',
        {
          objects: [[workspacePath, fileType, {}, '']],
          createUploadNodes: true,
          overwrite: false
        },
        token,
        sessionId
      );

      // Parse result: result[0][0] is metadata array
      if (!result || !result[0] || !result[0][0]) {
        console.error('[WorkspaceService] Invalid response from Workspace.create', { result });
        throw new Error('Invalid response from Workspace.create');
      }

      const metaArray = result[0][0];
      const nodeInfo = {
        id: metaArray[4],
        path: metaArray[2] + metaArray[0],
        name: metaArray[0],
        type: metaArray[1],
        uploadUrl: metaArray[11], // link_reference field
        size: metaArray[6],
        created: metaArray[3]
      };
      
      console.log(`[WorkspaceService] Workspace upload node created successfully`, {
        workspacePath: nodeInfo.path,
        nodeId: nodeInfo.id,
        hasUploadUrl: !!nodeInfo.uploadUrl
      });
      
      return nodeInfo;
    } catch (error) {
      console.error('[WorkspaceService] Failed to create workspace upload node', {
        fileName,
        workspacePath,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Upload file data to Shock URL
   */
  async uploadFileToShock(filePath, uploadUrl, token, sessionId = null) {
    const fileName = path.basename(filePath);
    
    if (!fs.existsSync(filePath)) {
      console.error(`[WorkspaceService] File not found for upload: ${filePath}`);
      throw new Error(`File not found: ${filePath}`);
    }

    // Get file size for logging
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    
    // Determine MIME type from extension
    const mimeType = this.getMimeType(filePath);
    
    console.log(`[WorkspaceService] Starting file upload to Shock API`, {
      fileName,
      fileSize: `${fileSizeMB} MB`,
      fileSizeBytes: fileSize,
      mimeType,
      uploadUrl: uploadUrl.substring(0, 100) + '...', // Truncate URL for logging
      sessionId: sessionId || 'none'
    });

    // Create form data with file
    const form = new FormData();
    form.append('upload', fs.createReadStream(filePath), {
      filename: fileName,
      contentType: mimeType
    });

    const headers = {
      ...form.getHeaders(),
      'Authorization': `OAuth ${token.replace(/^Bearer\s+/i, '')}`
    };

    try {
      const startTime = Date.now();
      const response = await axios.put(uploadUrl, form, {
        headers,
        timeout: 60000, // 60 second timeout for large files
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      const duration = Date.now() - startTime;
      const uploadSpeed = fileSize > 0 ? (fileSize / (1024 * 1024)) / (duration / 1000) : 0;

      if (response.status === 200) {
        console.log(`[WorkspaceService] File uploaded to Shock successfully`, {
          fileName,
          fileSize: `${fileSizeMB} MB`,
          duration: `${duration}ms`,
          uploadSpeed: `${uploadSpeed.toFixed(2)} MB/s`,
          statusCode: response.status
        });
        
        return {
          success: true,
          message: 'File uploaded successfully',
          statusCode: response.status,
          duration,
          fileSize,
          uploadSpeed
        };
      } else {
        console.warn(`[WorkspaceService] File upload returned non-200 status`, {
          fileName,
          statusCode: response.status,
          statusText: response.statusText
        });
        
        return {
          success: false,
          error: `Upload failed with status ${response.status}`,
          statusCode: response.status
        };
      }
    } catch (error) {
      console.error(`[WorkspaceService] File upload to Shock failed`, {
        fileName,
        fileSize: `${fileSizeMB} MB`,
        error: error.message,
        statusCode: error.response?.status,
        responseData: error.response?.data,
        stack: error.stack
      });
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  /**
   * Upload a file to BV-BRC workspace
   * 
   * @param {string} localFilePath - Path to file on local disk
   * @param {string} uploadDir - Workspace directory (e.g., "/username/home/Copilot Downloads")
   * @param {string} token - BV-BRC auth token
   * @param {string} sessionId - Optional session ID for logging
   * @returns {Object} Upload result with workspace path and status
   */
  async uploadFile(localFilePath, uploadDir, token, sessionId = null) {
    const fileName = path.basename(localFilePath);
    
    if (!token) {
      console.error('[WorkspaceService] Workspace upload attempted without authentication token');
      throw new Error('Authentication token is required for workspace upload');
    }

    if (!fs.existsSync(localFilePath)) {
      console.error(`[WorkspaceService] Local file not found for workspace upload: ${localFilePath}`);
      throw new Error(`Local file not found: ${localFilePath}`);
    }

    // Get file stats for logging
    const stats = fs.statSync(localFilePath);
    const fileSize = stats.size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    const userId = this.extractUserId(token);

    console.log(`[WorkspaceService] Starting workspace file upload`, {
      fileName,
      localFilePath,
      uploadDir,
      fileSize: `${fileSizeMB} MB`,
      fileSizeBytes: fileSize,
      userId: userId || 'unknown',
      sessionId: sessionId || 'none'
    });

    const uploadStartTime = Date.now();

    try {
      // Step 1: Create upload node and get URL
      console.log(`[WorkspaceService] Step 1: Creating workspace upload node`);
      const nodeInfo = await this.createUploadNode(localFilePath, uploadDir, token, sessionId);
      
      console.log(`[WorkspaceService] Upload node created, proceeding with file upload`, {
        workspacePath: nodeInfo.path,
        nodeId: nodeInfo.id
      });

      // Step 2: Upload file data
      console.log(`[WorkspaceService] Step 2: Uploading file data to Shock API`);
      const uploadResult = await this.uploadFileToShock(
        localFilePath,
        nodeInfo.uploadUrl,
        token,
        sessionId
      );

      const totalDuration = Date.now() - uploadStartTime;

      if (uploadResult.success) {
        console.log(`[WorkspaceService] Workspace file upload completed successfully`, {
          fileName,
          workspacePath: nodeInfo.path,
          fileSize: `${fileSizeMB} MB`,
          totalDuration: `${totalDuration}ms`,
          uploadSpeed: uploadResult.uploadSpeed ? `${uploadResult.uploadSpeed.toFixed(2)} MB/s` : 'N/A'
        });
        
        return {
          success: true,
          workspacePath: nodeInfo.path,
          fileName: nodeInfo.name,
          uploadUrl: nodeInfo.uploadUrl,
          fileSize,
          duration: totalDuration,
          uploadSpeed: uploadResult.uploadSpeed,
          message: 'File uploaded to workspace successfully'
        };
      } else {
        console.error(`[WorkspaceService] Workspace file upload failed`, {
          fileName,
          error: uploadResult.error,
          statusCode: uploadResult.statusCode
        });
        throw new Error(uploadResult.error);
      }
    } catch (error) {
      const totalDuration = Date.now() - uploadStartTime;
      
      console.error(`[WorkspaceService] Workspace file upload failed with exception`, {
        fileName,
        localFilePath,
        uploadDir,
        fileSize: `${fileSizeMB} MB`,
        duration: `${totalDuration}ms`,
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        error: error.message,
        fileName,
        fileSize,
        duration: totalDuration
      };
    }
  }

  /**
   * Resolve relative path to absolute workspace path
   */
  resolveWorkspacePath(relativePath, userId) {
    if (!relativePath) {
      return this.getUserHomePath(userId);
    }

    // If already absolute, return as-is
    if (relativePath.startsWith('/')) {
      return relativePath;
    }

    // Otherwise, prepend user's home path
    const homePath = this.getUserHomePath(userId);
    return `${homePath}/${relativePath}`.replace(/\/+/g, '/');
  }

  /**
   * Get workspace directory URL for a given workspace path
   * Extracts the directory portion (removes filename) and constructs browser URL
   * 
   * @param {string} workspacePath - Full workspace path including filename
   * @param {string} baseUrl - Base BV-BRC URL (default: https://www.bv-brc.org)
   * @returns {string} URL to the workspace directory
   */
  getWorkspaceDirectoryUrl(workspacePath, baseUrl = 'https://www.bv-brc.org') {
    if (!workspacePath) {
      return null;
    }

    // Extract directory path (remove filename)
    const dirPath = path.dirname(workspacePath);
    
    // Construct URL: baseUrl/workspace/dirPath
    // Remove leading slash from dirPath if present to avoid double slashes
    const cleanDirPath = dirPath.startsWith('/') ? dirPath : `/${dirPath}`;
    return `${baseUrl}/workspace${cleanDirPath}`;
  }
}

// Singleton instance
const workspaceService = new WorkspaceService();

module.exports = {
  WorkspaceService,
  workspaceService
};

