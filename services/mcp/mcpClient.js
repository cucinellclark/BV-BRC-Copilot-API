// services/mcp/mcpClient.js

const axios = require('axios');

class MCPError extends Error {
  constructor(message, statusCode = 500, originalError = null) {
    super(message);
    this.name = 'MCPError';
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}

class BVBRCMCPClient {
  constructor(serverUrl = 'http://140.221.78.15:5001') {
    this.serverUrl = serverUrl;
    this.timeout = 30000;
    this.maxRetries = 3;
    this.toolsCache = null;
    this.cacheExpiry = null;
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  async discoverTools(authToken = null) {
    try {
      console.log(`🌐 Connecting to MCP server: ${this.serverUrl}/mcp/tools/list`);
      
      const response = await axios.get(`${this.serverUrl}/mcp/tools/list`, {
        timeout: this.timeout
      });

      if (response.status !== 200) {
        throw new MCPError(`MCP server returned status ${response.status}`, response.status);
      }
      
      this.toolsCache = response.data.tools || [];
      this.cacheExpiry = Date.now() + this.cacheTimeout;
      console.log(`✅ Discovered ${this.toolsCache.length} tools: [${this.toolsCache.slice(0, 3).map(t => t.name).join(', ')}${this.toolsCache.length > 3 ? '...' : ''}]`);
      
      return this.toolsCache;
    } catch (error) {
      console.error(`❌ MCP server connection failed:`, error.message);
      console.error(`   Server URL: ${this.serverUrl}`);
      console.error(`   Error code: ${error.code}`);
      
      if (error.code === 'ECONNREFUSED') {
        throw new MCPError('MCP server is not available', 503, error);
      }
      if (error.code === 'ETIMEDOUT') {
        throw new MCPError('MCP server request timed out', 504, error);
      }
      if (error instanceof MCPError) {
        throw error;
      }
      throw new MCPError('Failed to discover MCP tools', 500, error);
    }
  }

  async callTool(toolName, args, authToken = null) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Initialize arguments object
        const toolArguments = args == null ? {} : { ...args };

        const payload = {
          name: toolName,
          arguments: toolArguments
        };

        // Add auth_token at the top level if provided
        if (authToken) {
          payload.auth_token = authToken;
        }

        // Create a copy of payload without auth_token for logging
        const logPayload = { ...payload };
        if (logPayload.auth_token) {
          delete logPayload.auth_token;
        }

        console.log(`🔧 Calling MCP tool: ${toolName} with args: ${JSON.stringify(toolArguments, null, 2)}`);
        console.log('payload: ', JSON.stringify(logPayload, null, 2));
        const response = await axios.post(`${this.serverUrl}/mcp/tools/call`, payload, {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        });
        console.log('response.status: ', response.status);
        console.log('response.headers: ', JSON.stringify(response.headers, null, 2));
        console.log('response.data: ', JSON.stringify(response.data, null, 2));

        if (response.status !== 200) {
          throw new MCPError(`Tool execution failed with status ${response.status}`, response.status);
        }

        // Check if response.data exists and has the expected structure
        if (!response.data) {
          throw new MCPError(`Tool execution failed: No response data received`, 500);
        }

        // Check if the response contains an error message despite 200 status
        if (response.data.error || response.data.status === 'error') {
          throw new MCPError(`Tool execution failed: ${response.data.error || response.data.message || 'Unknown error'}`, 500);
        }

        const result = {
          success: true,
          result: response.data,
          tool: toolName,
          execution_time: response.headers['x-execution-time'] || null
        };
        
        console.log('callTool returning result: ', JSON.stringify(result, null, 2));
        return result;
      } catch (error) {
        lastError = error;
        console.log('error: ', JSON.stringify(error, null, 2));
        console.log('error.message: ', error.message);
        console.log('error.name: ', error.name);
        console.log('error.stack: ', error.stack);
        if (error.code === 'ECONNREFUSED') {
          if (attempt === this.maxRetries) {
            throw new MCPError('MCP server is not available after retries', 503, error);
          }
          // Wait before retry
          await this.sleep(1000 * attempt);
          continue;
        }
        
        if (error.code === 'ETIMEDOUT') {
          throw new MCPError('MCP tool execution timed out', 504, error);
        }
        
        if (error instanceof MCPError) {
          throw error;
        }
        
        // Don't retry for other errors
        throw new MCPError(`Failed to execute tool ${toolName}`, 500, error);
      }
    }
    
    throw new MCPError(`Failed to execute tool ${toolName} after ${this.maxRetries} attempts`, 503, lastError);
  }

  async getAvailableTools(authToken = null) {
    if (this.toolsCache && this.cacheExpiry && Date.now() < this.cacheExpiry) {
      return this.toolsCache;
    }
    
    return await this.discoverTools(authToken);
  }

  async healthCheck() {
    try {
      const response = await axios.get(`${this.serverUrl}/health`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      console.error('MCP health check failed:', error.message);
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BVBRCMCPClient, MCPError };