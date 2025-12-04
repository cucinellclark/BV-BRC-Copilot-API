// services/mcp/mcpExecutor.js

const axios = require('axios');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { isLocalTool, executeLocalTool } = require('./localToolExecutor');
const config = require('./config.json');

/**
 * Execute an MCP tool or local pseudo-tool
 * 
 * @param {string} toolId - Full tool ID (e.g., "bvbrc_server.query_collection" or "local.create_workflow")
 * @param {object} parameters - Tool parameters
 * @param {string} authToken - Authentication token
 * @param {object} context - Additional context for local tools (query, model, etc.)
 * @returns {Promise<object>} Tool execution result
 */
async function executeMcpTool(toolId, parameters = {}, authToken = null, context = {}) {
  console.log(`[MCP Executor] Executing tool: ${toolId}`);
  console.log(`[MCP Executor] Parameters:`, JSON.stringify(parameters, null, 2));
  
  // Handle local pseudo-tools
  if (isLocalTool(toolId)) {
    console.log(`[MCP Executor] Routing to local tool executor`);
    return await executeLocalTool(toolId, parameters, context);
  }
  
  try {
    // Load tool definition
    let toolDef = await getToolDefinition(toolId);
    
    // If tool not found and toolId doesn't contain a dot, try to find it by name
    if (!toolDef && !toolId.includes('.')) {
      console.log(`[MCP Executor] Tool ID missing server prefix, searching by name: ${toolId}`);
      const manifest = await loadToolsManifest();
      if (manifest && manifest.tools) {
        // Find tool by name across all servers
        const foundTool = Object.entries(manifest.tools).find(
          ([fullToolId, tool]) => tool.name === toolId
        );
        if (foundTool) {
          const [fullToolId, tool] = foundTool;
          console.log(`[MCP Executor] Found tool by name, using full ID: ${fullToolId}`);
          toolDef = tool;
          toolId = fullToolId; // Update toolId for logging/error messages
        }
      }
    }
    
    if (!toolDef) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    
    // Get server config
    const serverKey = toolDef.server;
    const serverConfig = config.servers[serverKey];
    if (!serverConfig) {
      throw new Error(`Server configuration not found for: ${serverKey}`);
    }
    
    // Get or create session
    const sessionId = await sessionManager.getOrCreateSession(serverKey, serverConfig, authToken);
    
    // Build headers with session ID
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    };
    
    // Add auth token if needed
    const allowlist = config.global_settings?.token_server_allowlist || [];
    const shouldIncludeToken = allowlist.includes(serverKey);
    
    if (shouldIncludeToken && authToken) {
      headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
    }
    
    if (serverConfig.auth) {
      headers['Authorization'] = serverConfig.auth.startsWith('Bearer ') ? serverConfig.auth : `Bearer ${serverConfig.auth}`;
    }
    
    // Build JSON-RPC request
    const jsonRpcRequest = {
      jsonrpc: '2.0',
      id: `tool-${toolId}-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: toolDef.name,
        arguments: parameters
      }
    };
    
    const mcpEndpoint = `${serverConfig.url}/mcp`;
    const timeout = config.global_settings?.tool_execution_timeout || 60000;
    
    // Execute tool
    const response = await axios.post(mcpEndpoint, jsonRpcRequest, {
      timeout,
      headers,
      withCredentials: true
    });
    
    // Parse SSE format response if needed
    let responseData = response.data;
    if (typeof responseData === 'string') {
      const dataMatch = responseData.match(/data: (.+?)(?:\r?\n|$)/);
      if (dataMatch && dataMatch[1]) {
        responseData = JSON.parse(dataMatch[1]);
      }
    }
    
    // Check for JSON-RPC error
    if (responseData.error) {
      console.error(`[MCP Executor] Tool execution error:`, responseData.error);
      throw new Error(`Tool execution failed: ${responseData.error.message || JSON.stringify(responseData.error)}`);
    }
    
    const result = responseData.result;
    console.log(`[MCP Executor] Tool executed successfully`);
    console.log(`[MCP Executor] Result:`, JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error(`[MCP Executor] Error executing tool ${toolId}:`, error.message);
    
    // If session error, clear it and retry once
    if (error.message.includes('session') || error.message.includes('Session')) {
      const toolDef = await getToolDefinition(toolId);
      if (toolDef) {
        sessionManager.clearSession(toolDef.server);
      }
    }
    
    throw error;
  }
}

/**
 * Validate tool parameters against schema
 */
function validateToolParameters(toolDef, parameters) {
  const schema = toolDef.inputSchema;
  if (!schema) return true;
  
  const required = schema.required || [];
  const properties = schema.properties || {};
  
  // Check required fields
  for (const field of required) {
    if (!(field in parameters)) {
      throw new Error(`Missing required parameter: ${field}`);
    }
  }
  
  // Basic type checking
  for (const [key, value] of Object.entries(parameters)) {
    if (properties[key]) {
      const expectedType = properties[key].type;
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      
      if (expectedType === 'integer' || expectedType === 'number') {
        if (typeof value !== 'number') {
          throw new Error(`Parameter ${key} should be a number, got ${actualType}`);
        }
      } else if (expectedType === 'string' && typeof value !== 'string') {
        throw new Error(`Parameter ${key} should be a string, got ${actualType}`);
      } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Parameter ${key} should be a boolean, got ${actualType}`);
      }
    }
  }
  
  return true;
}

module.exports = {
  executeMcpTool,
  validateToolParameters,
  sessionManager
};

