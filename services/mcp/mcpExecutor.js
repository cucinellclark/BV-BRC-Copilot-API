// services/mcp/mcpExecutor.js

const axios = require('axios');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { isLocalTool, executeLocalTool } = require('./localToolExecutor');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');
const config = require('./config.json');

const DEFAULT_RAG_FRAGMENTS = ['helpdesk_service_usage'];

function isRagTool(toolId) {
  if (!toolId) return false;
  const ragList = config.global_settings?.rag_tools || DEFAULT_RAG_FRAGMENTS;
  return ragList.some(fragment => toolId.includes(fragment));
}

function isFinalizeTool(toolId) {
  if (!toolId) return false;
  const finalizeList = config.global_settings?.finalize_tools || [];
  return finalizeList.some(fragment => toolId.includes(fragment));
}

function normalizeRagResult(rawResult, maxDocs = 5) {
  const docs = rawResult?.used_documents || rawResult?.results || [];
  const limitedDocs = Array.isArray(docs) ? docs.slice(0, maxDocs) : [];

  return {
    type: 'rag_result',
    query: rawResult?.query,
    index: rawResult?.index,
    count: rawResult?.count ?? limitedDocs.length,
    summary: rawResult?.summary,
    documents: limitedDocs
  };
}

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
    
    // If tool not found, try to find it by name across all servers (even if a prefix was provided)
    if (!toolDef) {
      const manifest = await loadToolsManifest();
      if (manifest && manifest.tools) {
        const toolName = toolId.includes('.') ? toolId.split('.').pop() : toolId;
        
        // Find tool by name across all servers
        const foundTool = Object.entries(manifest.tools).find(
          ([fullToolId, tool]) => tool.name === toolName
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
    console.log('**********MCP TOOL RESPONSE:***********\n', response.data);
    
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
    
    let result = responseData.result;
    log.info('Tool executed successfully', { toolId });

    // Special-case RAG tools: extract actual data from MCP content wrapper
    if (isRagTool(toolId)) {
      // MCP tools return results wrapped in content structure - extract the actual data
      let extractedData = null;
      
      // Try structuredContent.result first (preferred)
      if (result?.structuredContent?.result) {
        try {
          extractedData = JSON.parse(result.structuredContent.result);
          log.debug('Extracted RAG data from structuredContent.result');
        } catch (parseError) {
          log.warn('Failed to parse structuredContent.result', { error: parseError.message });
        }
      }
      
      // Fallback to content[0].text
      if (!extractedData && result?.content && Array.isArray(result.content) && result.content[0]?.text) {
        try {
          extractedData = JSON.parse(result.content[0].text);
          log.debug('Extracted RAG data from content[0].text');
        } catch (parseError) {
          log.warn('Failed to parse content[0].text', { error: parseError.message });
        }
      }
      
      if (extractedData) {
        result = extractedData;
      } else {
        log.warn('Could not extract RAG data from MCP wrapper, using result as-is');
      }
      
      // Log raw helpdesk/RAG response for debugging
      log.info('RAG tool raw result', {
        toolId,
        keys: Object.keys(result || {}),
        count: result?.count,
        resultsLength: Array.isArray(result?.results) ? result.results.length : null,
        usedDocsLength: Array.isArray(result?.used_documents) ? result.used_documents.length : null,
        documentsLength: Array.isArray(result?.documents) ? result.documents.length : null,
        summaryPreview: typeof result?.summary === 'string' ? result.summary.substring(0, 200) : null
      });
      // Also emit to stdout for immediate visibility
      console.log('[RAG raw result]', {
        toolId,
        keys: Object.keys(result || {}),
        count: result?.count,
        resultsLength: Array.isArray(result?.results) ? result.results.length : null,
        usedDocsLength: Array.isArray(result?.used_documents) ? result.used_documents.length : null,
        documentsLength: Array.isArray(result?.documents) ? result.documents.length : null,
        summaryPreview: typeof result?.summary === 'string' ? result.summary.substring(0, 200) : null
      });

      log.debug('Normalizing RAG tool result', {
        toolId,
        hasResults: !!result?.results,
        hasUsedDocuments: !!result?.used_documents,
        hasSummary: !!result?.summary,
        summaryPreview: typeof result?.summary === 'string' ? result.summary.substring(0, 100) : null
      });
      const normalized = normalizeRagResult(result, config.global_settings?.rag_max_docs);
      log.debug('RAG result normalized', {
        type: normalized.type,
        hasDocuments: !!normalized.documents,
        documentsCount: normalized.documents?.length,
        hasSummary: !!normalized.summary,
        summaryPreview: typeof normalized.summary === 'string' ? normalized.summary.substring(0, 100) : null
      });
      return normalized;
    }
    
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
  sessionManager,
  isRagTool,
  isFinalizeTool
};

