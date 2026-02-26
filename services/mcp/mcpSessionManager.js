// services/mcp/mcpSessionManager.js

const axios = require('axios');
const config = require('./config.json');

/**
 * MCP Session Manager - maintains active sessions with MCP servers
 * Extracted to avoid circular dependencies between toolDiscovery and mcpExecutor
 */
class McpSessionManager {
  constructor() {
    this.sessions = new Map(); // serverKey -> sessionId
  }

  async getOrCreateSession(serverKey, serverConfig, authToken) {
    // Check if we have an active session
    if (this.sessions.has(serverKey)) {
      return this.sessions.get(serverKey);
    }

    // Create new session
    const sessionId = await this.initializeSession(serverKey, serverConfig, authToken);
    this.sessions.set(serverKey, sessionId);
    return sessionId;
  }

  async initializeSession(serverKey, serverConfig, authToken) {
    const mcpEndpoint = `${serverConfig.url}/mcp`;
    
    // Check if this server should receive the auth token
    const allowlist = config.global_settings?.token_server_allowlist || [];
    const shouldIncludeToken = allowlist.includes(serverKey);
    
    // Build headers
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    
    // Add auth token if server is in allowlist
    if (shouldIncludeToken && authToken) {
      headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
    }
    
    // Fallback to server-specific auth if configured
    if (serverConfig.auth) {
      headers['Authorization'] = serverConfig.auth.startsWith('Bearer ') ? serverConfig.auth : `Bearer ${serverConfig.auth}`;
    }
    
    // Initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: `init-${serverKey}-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'bvbrc-copilot-client',
          version: '1.0.0'
        }
      }
    };
    
    try {
      const response = await axios.post(mcpEndpoint, initRequest, {
        timeout: serverConfig.timeout || 10000,
        headers,
        withCredentials: true
      });
      
      // Parse SSE format response if needed
      let initData = response.data;
      if (typeof initData === 'string') {
        const dataMatch = initData.match(/data: (.+?)(?:\r?\n|$)/);
        if (dataMatch && dataMatch[1]) {
          initData = JSON.parse(dataMatch[1]);
        }
      }
      
      // Check for initialization error
      if (initData.error) {
        throw new Error(`Initialization failed: ${initData.error.message || JSON.stringify(initData.error)}`);
      }
      
      // Extract session ID
      const sessionId = response.headers['mcp-session-id'] || 
                        response.headers['x-session-id'] || 
                        response.headers['session-id'] ||
                        initData.result?.sessionId ||
                        initData.result?.session_id;
      
      if (!sessionId) {
        throw new Error('No session ID received from server');
      }
      
      console.log(`[MCP Session Manager] Session initialized for ${serverKey}: ${sessionId}`);
      return sessionId;
    } catch (error) {
      console.error(`[MCP Session Manager] Failed to initialize session for ${serverKey}:`, error.message);
      throw error;
    }
  }

  clearSession(serverKey) {
    this.sessions.delete(serverKey);
  }

  clearAllSessions() {
    this.sessions.clear();
  }
}

// Export singleton instance
const sessionManager = new McpSessionManager();

module.exports = {
  sessionManager,
  McpSessionManager
};

