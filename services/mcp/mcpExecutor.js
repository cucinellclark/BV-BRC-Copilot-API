// services/mcp/mcpExecutor.js

const axios = require('axios');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { isLocalTool, executeLocalTool } = require('./localToolExecutor');
const { McpStreamHandler } = require('./mcpStreamHandler');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');

// Initialize stream handler
const streamHandler = new McpStreamHandler(fileManager);
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

function shouldBypassFileHandling(toolId) {
  if (!toolId) return false;
  const bypassList = config.global_settings?.bypass_file_handling_tools || [];
  return bypassList.some(fragment => toolId.includes(fragment));
}

/**
 * Unwrap MCP content wrapper to extract actual data
 * MCP tools return results wrapped in content/structuredContent structure
 */
function unwrapMcpContent(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  
  // Try structuredContent.result first (preferred)
  if (result.structuredContent?.result) {
    try {
      // If it's a JSON string, parse it
      if (typeof result.structuredContent.result === 'string') {
        return JSON.parse(result.structuredContent.result);
      }
      // If it's already an object, return it
      return result.structuredContent.result;
    } catch (parseError) {
      // If parsing fails, return the string as-is
      return result.structuredContent.result;
    }
  }
  
  // Fallback to content[0].text
  if (result.content && Array.isArray(result.content) && result.content[0]?.text !== undefined) {
    const textContent = result.content[0].text;
    try {
      // If it's a JSON string, parse it
      if (typeof textContent === 'string') {
        // Try to parse as JSON, but if it's not valid JSON, return as string
        const trimmed = textContent.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(textContent);
        }
        // Not JSON, return as string
        return textContent;
      }
      // If it's already an object/array, return it as-is
      // (some MCP servers return objects directly in the text field)
      return textContent;
    } catch (parseError) {
      // If parsing fails, return the string as-is
      return textContent;
    }
  }
  
  // No wrapper detected, return as-is
  return result;
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
    documents: limitedDocs,
    source: rawResult?.source || 'bvbrc-rag'
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
 * @param {string} toolId - Full tool ID (e.g., "bvbrc_server.query_collection" or "local.get_file_info")
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
    
    // Auto-enable streaming if tool has streamingHint annotation
    // Force streaming when streamingHint is present, regardless of parameter value
    const autoEnableStreaming = config.streaming?.autoEnableOnHint !== false;
    if (autoEnableStreaming && toolDef.annotations?.streamingHint === true) {
      if (parameters.stream === false) {
        log.info('Overriding stream=false due to streamingHint annotation', { toolId });
      }
      parameters.stream = true;
      log.debug('Streaming enabled based on streamingHint annotation', { toolId });
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
    const timeout = config.global_settings?.tool_execution_timeout || 120000;
    
    // Execute tool with streaming support
    const executionResult = await streamHandler.executeWithStreaming(
      mcpEndpoint,
      jsonRpcRequest,
      headers,
      timeout,
      context,
      toolId,
      log
    );
    
    let responseData = executionResult.data;
    const isStreamingResponse = executionResult.streaming;
    
    if (isStreamingResponse) {
      log.info('Streaming response received and merged', {
        totalBatches: responseData._batchCount,
        totalResults: responseData.count
      });
    } else {
      // Parse SSE format response if needed (non-streaming)
      if (typeof responseData === 'string') {
        const dataMatch = responseData.match(/data: (.+?)(?:\r?\n|$)/);
        if (dataMatch && dataMatch[1]) {
          responseData = JSON.parse(dataMatch[1]);
        }
      }
    }
    
    // Check for JSON-RPC error or MCP error
    if (responseData.error) {
      log.error('Tool execution error', { 
        toolId, 
        error: responseData.error,
        partial: responseData.partial,
        mcpError: responseData.mcpError
      });
      
      // If MCP error (not partial data), throw immediately
      if (responseData.mcpError) {
        throw new Error(`MCP tool error: ${responseData.error}`);
      }
      
      // If partial results from streaming, return what we have with error flag
      if (responseData.partial && responseData.batchesReceived > 0) {
        log.warn('Returning partial streaming results', {
          batchesReceived: responseData.batchesReceived,
          totalResults: responseData.totalResults
        });
        return {
          error: responseData.error,
          partial: true,
          results: responseData.results || [],
          count: responseData.totalResults || 0,
          batchesReceived: responseData.batchesReceived,
          message: `Partial results: ${responseData.error}`
        };
      }
      
      throw new Error(`Tool execution failed: ${responseData.error.message || JSON.stringify(responseData.error)}`);
    }
    
    let result = isStreamingResponse ? responseData : responseData.result;
    log.info('Tool executed successfully', { toolId });

    // Universal MCP unwrapping - all tools return data wrapped in content/structuredContent
    // Apply unwrapping before any other processing
    const unwrappedResult = unwrapMcpContent(result);
    log.debug('Unwrapped MCP content', {
      toolId,
      hadWrapper: unwrappedResult !== result,
      resultType: typeof unwrappedResult,
      source: unwrappedResult?.source
    });
    result = unwrappedResult;

    // Special-case RAG tools: normalize and limit documents
    if (isRagTool(toolId)) {
      log.info('Processing RAG tool result', {
        toolId,
        source: result?.source,
        count: result?.count,
        hasResults: !!result?.results,
        hasSummary: !!result?.summary
      });
      
      const normalized = normalizeRagResult(result, config.global_settings?.rag_max_docs);
      log.debug('RAG result normalized', {
        type: normalized.type,
        documentsCount: normalized.documents?.length,
        hasSummary: !!normalized.summary
      });
      return normalized;
    }
    
    // Process result through file manager if session_id is available
    // All results are now saved to disk and return a file reference
    // Unless the tool is configured to bypass file handling
    if (context.session_id && !shouldBypassFileHandling(toolId)) {
      log.debug('Processing result for session', { session_id: context.session_id });
      
      // Build context for file manager (includes workspace upload info)
      const fileManagerContext = {
        authToken: authToken,
        user_id: context.user_id,
        session_id: context.session_id
      };
      
      // Pass batch count as estimated pages for streaming responses
      const estimatedPages = isStreamingResponse && responseData._batchCount 
        ? responseData._batchCount 
        : null;
      
      const processedResult = await fileManager.processToolResult(
        context.session_id,
        toolId,
        result,
        fileManagerContext,
        estimatedPages
      );
      
      // All results are now saved to file (no inline results)
      if (processedResult.type === 'file_reference') {
        log.info('Result saved to file', { 
          fileName: processedResult.fileName,
          recordCount: processedResult.summary?.recordCount,
          size: processedResult.summary?.sizeFormatted,
          workspacePath: processedResult.workspace?.workspacePath
        });
        return processedResult;
      } else {
        // Should not happen, but handle gracefully
        log.warn('Unexpected result type from fileManager', { type: processedResult.type });
        return processedResult;
      }
    } else if (shouldBypassFileHandling(toolId)) {
      log.debug('Bypassing file handling for tool', { 
        toolId, 
        session_id: context.session_id,
        source: result?.source
      });
    } else {
      log.debug('No session_id in context, returning result directly (not saved to file)');
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

