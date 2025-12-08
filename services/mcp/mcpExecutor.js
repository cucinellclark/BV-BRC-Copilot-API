// services/mcp/mcpExecutor.js

const axios = require('axios');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { isLocalTool, executeLocalTool } = require('./localToolExecutor');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');
const config = require('./config.json');

// Initialize file manager on module load
const initLogger = createLogger('MCP-Init');
fileManager.init().catch(err => {
  initLogger.error('Failed to initialize file manager', { error: err.message, stack: err.stack });
});

/**
 * Execute an MCP tool or local pseudo-tool
 * 
 * @param {string} toolId - Full tool ID (e.g., "bvbrc_server.query_collection" or "local.create_workflow")
 * @param {object} parameters - Tool parameters
 * @param {string} authToken - Authentication token
 * @param {object} context - Additional context for local tools (query, model, etc.)
 * @param {Logger} logger - Optional logger instance
 * @returns {Promise<object>} Tool execution result
 */
async function executeMcpTool(toolId, parameters = {}, authToken = null, context = {}, logger = null) {
  const log = logger || createLogger('MCP-Executor', context.session_id);
  
  log.info(`Executing tool: ${toolId}`, { parameters });
  
  // Handle local pseudo-tools
  if (isLocalTool(toolId)) {
    log.info('Routing to local tool executor');
    return await executeLocalTool(toolId, parameters, context, log);
  }
  
  try {
    // Load tool definition
    let toolDef = await getToolDefinition(toolId);
    
    // If tool not found and toolId doesn't contain a dot, try to find it by name
    if (!toolDef && !toolId.includes('.')) {
      log.debug('Tool ID missing server prefix, searching by name', { toolId });
      const manifest = await loadToolsManifest();
      if (manifest && manifest.tools) {
        // Find tool by name across all servers
        const foundTool = Object.entries(manifest.tools).find(
          ([fullToolId, tool]) => tool.name === toolId
        );
        if (foundTool) {
          const [fullToolId, tool] = foundTool;
          log.info('Found tool by name, using full ID', { originalId: toolId, fullToolId });
          toolDef = tool;
          toolId = fullToolId; // Update toolId for logging/error messages
        }
      }
    }
    
    if (!toolDef) {
      log.error('Tool not found', { toolId });
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
      log.error('Tool execution error', { 
        toolId, 
        error: responseData.error 
      });
      throw new Error(`Tool execution failed: ${responseData.error.message || JSON.stringify(responseData.error)}`);
    }
    
    const result = responseData.result;
    log.info('Tool executed successfully', { toolId });
    
    // Process result through file manager if session_id is available
    // This will save large results to disk and return a file reference
    if (context.session_id) {
      log.debug('Processing result for session', { session_id: context.session_id });
      const processedResult = await fileManager.processToolResult(
        context.session_id,
        toolId,
        result
      );
      
      if (processedResult.type === 'file_reference') {
        log.info('Large result saved to file', { 
          fileName: processedResult.fileName,
          recordCount: processedResult.summary?.recordCount 
        });
        return processedResult;
      } else if (processedResult.type === 'inline') {
        log.debug('Result returned inline');
        return processedResult.data;
      }
    } else {
      log.debug('No session_id in context, returning result inline');
    }
    
    return result;
  } catch (error) {
    log.error('Error executing tool', { 
      toolId, 
      error: error.message, 
      stack: error.stack 
    });
    
    // If session error, clear it and retry once
    if (error.message.includes('session') || error.message.includes('Session')) {
      log.warn('Session error detected, clearing session', { toolId });
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

