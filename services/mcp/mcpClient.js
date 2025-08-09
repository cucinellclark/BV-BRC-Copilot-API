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
      
      const payload = {};
      if (authToken) {
        payload.auth_token = authToken;
      }
      
      const headers = {
        'Content-Type': 'application/json'
      };
      
      const response = await axios.post(`${this.serverUrl}/mcp/tools/list`, payload, {
        timeout: this.timeout,
        headers
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
        const payload = {
          name: toolName,
          arguments: args == null ? {} : args
        };

        if (authToken) {
          payload.auth_token = authToken;
        }

        console.log(`🔧 Calling MCP tool: ${toolName} with args: ${JSON.stringify(args, null, 2).substring(0, 200)}${JSON.stringify(args, null, 2).length > 200 ? '...' : ''}`);

        const response = await axios.post(`${this.serverUrl}/mcp/tools/call`, payload, {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.status !== 200) {
          throw new MCPError(`Tool execution failed with status ${response.status}`, response.status);
        }

        return {
          success: true,
          result: response.data,
          tool: toolName,
          execution_time: response.headers['x-execution-time'] || null
        };
      } catch (error) {
        lastError = error;
        
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