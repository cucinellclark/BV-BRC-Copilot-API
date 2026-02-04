// services/mcp/mcpExecutor.js

const axios = require('axios');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { isLocalTool, executeLocalTool } = require('./localToolExecutor');
const { McpStreamHandler } = require('./mcpStreamHandler');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');
const { emitSSE } = require('../sseUtils');

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

/**
 * Check if tool is a query_collection tool that supports pagination
 */
function isQueryCollectionTool(toolId) {
  if (!toolId) return false;
  return toolId.includes('query_collection');
}

/**
 * Paginate through all results for query_collection tool using cursor-based pagination
 * @param {string} toolId - Full tool ID
 * @param {object} originalParameters - Original tool parameters
 * @param {object} firstResponse - First response from the tool
 * @param {string} authToken - Authentication token
 * @param {object} context - Execution context
 * @param {Logger} log - Logger instance
 * @returns {Promise<object>} Merged result with all paginated data
 */
async function paginateQueryCollection(toolId, originalParameters, firstResponse, authToken, context, log) {
  // Check if pagination is needed
  const nextCursorId = firstResponse?.nextCursorId;
  const totalCount = firstResponse?.numFound || firstResponse?.count || 0;
  
  // Skip pagination for countOnly queries
  if (originalParameters.countOnly) {
    log.debug('Skipping pagination for countOnly query', { totalCount });
    return firstResponse;
  }
  
  // Skip pagination if cursorId was provided in original parameters
  // This means the caller is already doing manual pagination
  if (originalParameters.cursorId && originalParameters.cursorId !== '*') {
    log.debug('Skipping auto-pagination - cursorId already provided in request', { 
      cursorId: originalParameters.cursorId.substring(0, 20) + '...',
      totalCount,
      message: 'Caller is handling pagination manually'
    });
    return firstResponse;
  }
  
  if (!nextCursorId || nextCursorId === null) {
    log.debug('No pagination needed - single page result', {
      totalCount,
      resultCount: firstResponse?.results?.length || 0
    });
    return firstResponse;
  }
  
  log.info('Starting cursor-based pagination', {
    toolId,
    totalCount,
    firstBatchCount: firstResponse?.results?.length || 0,
    estimatedBatches: Math.ceil(totalCount / (firstResponse?.results?.length || 1000)),
    nextCursorId
  });
  
  // Warn if very large result set
  if (totalCount > 50000) {
    log.warn('Large result set detected - pagination may take time and use significant memory', {
      totalCount,
      estimatedBatches: Math.ceil(totalCount / (firstResponse?.results?.length || 1000))
    });
  }
  
  // Detect format: TSV (string) or JSON (array)
  const isTsvFormat = firstResponse.tsv !== undefined && typeof firstResponse.tsv === 'string';
  const isJsonFormat = Array.isArray(firstResponse.results);
  
  // Initialize accumulator based on format
  let allResults = [];
  let allTsv = '';
  let currentCount;
  if (isTsvFormat) {
    // For TSV, start with the first batch (includes header)
    allTsv = firstResponse.tsv || '';
    // Extract header line for later batches
    const tsvLines = allTsv.split('\n').filter(line => line.trim().length > 0);
    // Count records (excluding header)
    currentCount = Math.max(0, tsvLines.length - 1);
  } else if (isJsonFormat) {
    allResults = [...firstResponse.results];
    currentCount = firstResponse?.count || allResults.length;
  } else {
    // Fallback: try to get count from response
    currentCount = firstResponse?.count || 0;
  }
  
  let batchNumber = 1;
  let cursor = nextCursorId;
  const errors = [];
  const responseStream = context.responseStream;
  const MAX_PAGINATION_BATCHES = 200; // Safety limit to prevent runaway pagination
  
  // Send initial progress update
  if (responseStream && totalCount > 0) {
    emitSSE(responseStream, 'query_progress', {
      tool: toolId,
      current: currentCount,
      total: totalCount,
      percentage: Math.floor((currentCount / totalCount) * 100),
      batchNumber: batchNumber,
      timestamp: new Date().toISOString()
    });
  }
  
  // Pagination loop
  while (cursor && cursor !== null && batchNumber < MAX_PAGINATION_BATCHES) {
    batchNumber++;
    
    try {
      log.debug(`Fetching pagination batch ${batchNumber}`, {
        cursor: cursor.substring(0, 20) + '...', // Log first 20 chars only
        currentCount,
        totalCount
      });
      
      // Create pagination parameters - preserve all original params, add cursorId
      const paginationParams = {
        ...originalParameters,
        cursorId: cursor
      };
      
      // Execute pagination request
      // We need to call the tool again, but we'll do it through the same execution path
      // Get tool definition again
      const toolDef = await getToolDefinition(toolId);
      
      if (!toolDef) {
        throw new Error(`Tool definition not found for pagination: ${toolId}`);
      }
      
      // Get server config
      const serverKey = toolDef.server;
      const serverConfig = config.servers[serverKey];
      if (!serverConfig) {
        throw new Error(`Server configuration not found for: ${serverKey}`);
      }
      
      // Get or create session
      const sessionId = await sessionManager.getOrCreateSession(serverKey, serverConfig, authToken);
      
      // Build headers
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
      
      // Build JSON-RPC request for pagination
      const jsonRpcRequest = {
        jsonrpc: '2.0',
        id: `tool-${toolId}-pagination-${batchNumber}-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: toolDef.name,
          arguments: paginationParams
        }
      };
      
      const mcpEndpoint = `${serverConfig.url}/mcp`;
      const timeout = config.global_settings?.tool_execution_timeout || 120000;
      
      // Execute pagination request (non-streaming for pagination)
      const response = await axios.post(mcpEndpoint, jsonRpcRequest, {
        timeout,
        headers,
        withCredentials: true
      });
      
      let responseData = response.data;
      
      // Parse SSE format if needed (MCP server may return SSE even for non-streaming requests)
      if (typeof responseData === 'string') {
        log.debug(`Pagination batch ${batchNumber} returned string, parsing SSE format`);
        const dataMatch = responseData.match(/data: (.+?)(?:\r?\n|$)/);
        if (dataMatch && dataMatch[1]) {
          try {
            responseData = JSON.parse(dataMatch[1]);
            log.debug(`Successfully parsed SSE data for batch ${batchNumber}`);
          } catch (parseError) {
            log.error(`Failed to parse SSE data for batch ${batchNumber}`, {
              error: parseError.message,
              dataPreview: dataMatch[1].substring(0, 200)
            });
            throw new Error(`Failed to parse SSE response: ${parseError.message}`);
          }
        } else {
          log.error(`No SSE data found in string response for batch ${batchNumber}`, {
            responsePreview: responseData.substring(0, 200)
          });
          throw new Error('Invalid SSE format in pagination response');
        }
      }
      
      // Check for errors
      if (responseData.error) {
        throw new Error(`Pagination error: ${responseData.error.message || JSON.stringify(responseData.error)}`);
      }
      
      // Unwrap MCP content
      let batchResult = responseData.result;
      
      log.debug(`Raw pagination batch ${batchNumber} response`, {
        hasResult: !!responseData.result,
        resultType: typeof responseData.result,
        resultKeys: responseData.result ? Object.keys(responseData.result) : []
      });
      
      batchResult = unwrapMcpContent(batchResult);
      
      log.debug(`Unwrapped pagination batch ${batchNumber}`, {
        hasBatchResult: !!batchResult,
        batchResultType: typeof batchResult,
        isObject: batchResult && typeof batchResult === 'object',
        batchResultKeys: batchResult && typeof batchResult === 'object' ? Object.keys(batchResult) : [],
        hasResults: batchResult?.results !== undefined,
        hasNextCursorId: batchResult?.nextCursorId !== undefined,
        resultsType: batchResult?.results ? typeof batchResult.results : 'undefined',
        resultsIsArray: Array.isArray(batchResult?.results)
      });
      
      // Validate batch result structure
      if (!batchResult || typeof batchResult !== 'object') {
        log.error(`Invalid batch result structure for batch ${batchNumber}`, {
          batchResult: batchResult,
          type: typeof batchResult,
          rawResult: JSON.stringify(responseData).substring(0, 500)
        });
        throw new Error('Invalid batch result structure');
      }
      
      // Check for error in result
      if (batchResult.error) {
        throw new Error(`Batch error: ${batchResult.error}`);
      }
      
      // Extract batch data based on format
      let batchCount = 0;
      const nextCursor = batchResult.nextCursorId;
      
      if (isTsvFormat && batchResult.tsv) {
        // TSV format: extract TSV string and append (skip header line for batches after the first)
        const batchTsv = batchResult.tsv;
        const tsvLines = batchTsv.split('\n').filter(line => line.trim().length > 0);
        
        if (tsvLines.length > 0) {
          // Skip header line (first line) for all batches in the loop (batchNumber >= 2)
          // The first batch header is already in allTsv
          const dataLines = tsvLines.slice(1); // Always skip header for pagination batches
          if (dataLines.length > 0) {
            allTsv += '\n' + dataLines.join('\n');
          }
          batchCount = dataLines.length;
        }
      } else if (isJsonFormat) {
        // JSON format: extract results array
        const batchResults = Array.isArray(batchResult.results) ? batchResult.results : [];
        batchCount = batchResult.count || batchResults.length;
        allResults.push(...batchResults);
      } else {
        // Fallback: try to get count
        batchCount = batchResult.count || 0;
      }
      
      // Safety check: if batch is empty and cursor is still present, something is wrong
      if (batchCount === 0 && nextCursor && nextCursor !== null) {
        log.warn('Empty batch with non-null cursor - stopping pagination to prevent infinite loop', {
          batchNumber,
          cursor: cursor.substring(0, 20) + '...'
        });
        break;
      }
      
      currentCount += batchCount;
      
      log.debug(`Pagination batch ${batchNumber} completed`, {
        batchCount,
        cumulativeCount: currentCount,
        totalCount,
        hasNextCursor: !!nextCursor
      });
      
      // Send progress update
      if (responseStream) {
        const percentage = totalCount > 0 
          ? Math.floor((currentCount / totalCount) * 100)
          : 0;
        
        log.info(`Sending pagination progress update for batch ${batchNumber}`, {
          current: currentCount,
          total: totalCount,
          percentage,
          batchNumber
        });
        
        emitSSE(responseStream, 'query_progress', {
          tool: toolId,
          current: currentCount,
          total: totalCount,
          percentage: percentage,
          batchNumber: batchNumber,
          timestamp: new Date().toISOString()
        });
      } else {
        log.warn(`No responseStream available for progress update at batch ${batchNumber}`, {
          hasContext: !!context,
          contextKeys: context ? Object.keys(context) : []
        });
      }
      
      // Update cursor for next iteration
      cursor = nextCursor;
      
      // Break if no more pages
      if (!cursor || cursor === null) {
        log.info('Pagination complete - no more pages', {
          totalBatches: batchNumber,
          totalResults: currentCount
        });
        break;
      }
      
    } catch (error) {
      log.error(`Error during pagination batch ${batchNumber}`, {
        error: error.message,
        stack: error.stack,
        cursor: cursor ? cursor.substring(0, 20) + '...' : null
      });
      
      errors.push({
        batchNumber,
        error: error.message,
        cursor: cursor ? cursor.substring(0, 20) + '...' : null
      });
      
      // Send error event
      if (responseStream) {
        emitSSE(responseStream, 'query_error', {
          tool: toolId,
          error: error.message,
          partial: true,
          batchesReceived: batchNumber - 1,
          totalResults: currentCount,
          expectedTotal: totalCount,
          batchNumber: batchNumber
        });
      }
      
      // Return partial results with error
      const partialResult = {
        count: isTsvFormat ? currentCount : allResults.length,
        numFound: totalCount,
        source: 'bvbrc-mcp-data',
        error: `Pagination error at batch ${batchNumber}: ${error.message}`,
        partial: true,
        batchesReceived: batchNumber - 1,
        totalResults: currentCount,
        expectedTotal: totalCount,
        paginationErrors: errors
      };
      
      if (isTsvFormat) {
        partialResult.tsv = allTsv;
      } else {
        partialResult.results = allResults;
      }
      
      return partialResult;
    }
  }
  
  // Check if we hit the safety limit
  if (batchNumber >= MAX_PAGINATION_BATCHES && cursor && cursor !== null) {
    log.warn('Reached maximum pagination batch limit', {
      maxBatches: MAX_PAGINATION_BATCHES,
      totalRetrieved: currentCount,
      expectedTotal: totalCount,
      hasMoreData: true
    });
    
    // Send warning via SSE
    if (responseStream) {
      emitSSE(responseStream, 'query_warning', {
        tool: toolId,
        warning: 'Reached maximum pagination limit',
        maxBatches: MAX_PAGINATION_BATCHES,
        totalRetrieved: currentCount,
        expectedTotal: totalCount,
        message: `Retrieved ${currentCount} of ${totalCount} results. Increase MAX_PAGINATION_BATCHES if needed.`
      });
    }
  }
  
  // Pagination complete - merge all results
  const finalCount = isTsvFormat ? currentCount : allResults.length;
  log.info('Pagination completed successfully', {
    totalBatches: batchNumber,
    totalResults: finalCount,
    expectedTotal: totalCount,
    errors: errors.length,
    format: isTsvFormat ? 'tsv' : 'json',
    complete: finalCount >= totalCount || !cursor
  });
  
  // Return merged result based on format
  const mergedResult = {
    count: finalCount,
    numFound: totalCount,
    source: 'bvbrc-mcp-data',
    _paginationInfo: {
      totalBatches: batchNumber,
      errors: errors.length > 0 ? errors : undefined
    }
  };
  
  // Preserve query parameters from the parameters that were actually used
  // Note: originalParameters here refers to the parameters passed to this function,
  // which have already been modified (e.g., format forced to 'tsv') before pagination
  if (originalParameters) {
    const queryParams = { ...originalParameters };
    // Remove cursorId as it's an internal pagination parameter
    delete queryParams.cursorId;
    mergedResult.queryParameters = queryParams;
  }
  
  if (isTsvFormat) {
    mergedResult.tsv = allTsv;
  } else {
    mergedResult.results = allResults;
  }
  
  return mergedResult;
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
    
    // Disable streaming for query_collection tools - they use cursor pagination instead
    // MCP streaming (SSE batches) conflicts with cursor-based pagination (multiple HTTP requests)
    if (isQueryCollectionTool(toolId)) {
      if (parameters.stream === true) {
        log.info('Disabling stream parameter for query_collection - using cursor pagination instead', { 
          toolId 
        });
        parameters.stream = false;
      }
      
      // Override format to always use TSV for query_collection tools
      if (parameters.format !== 'tsv') {
        log.info('Overriding format parameter for query_collection - forcing TSV format', { 
          toolId,
          originalFormat: parameters.format 
        });
        parameters.format = 'tsv';
      }
    } else {
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
    log.info('Tool executed successfully', { 
      toolId,
      isStreamingResponse 
    });

    // Universal MCP unwrapping - all tools return data wrapped in content/structuredContent
    // Apply unwrapping before any other processing
    const unwrappedResult = unwrapMcpContent(result);
    log.info('Unwrapped MCP content', {
      toolId,
      hadWrapper: unwrappedResult !== result,
      resultType: typeof unwrappedResult,
      source: unwrappedResult?.source,
      isArray: Array.isArray(unwrappedResult),
      hasResults: !!unwrappedResult?.results,
      hasNextCursorId: !!unwrappedResult?.nextCursorId
    });
    result = unwrappedResult;

    // Special-case query_collection tool: handle cursor-based pagination
    if (isQueryCollectionTool(toolId)) {
      log.info('Detected query_collection tool - checking pagination requirements', {
        toolId,
        resultType: typeof result,
        isObject: result && typeof result === 'object',
        hasNextCursorId: !!result?.nextCursorId,
        nextCursorIdValue: result?.nextCursorId ? result.nextCursorId.substring(0, 30) + '...' : 'null',
        hasResults: Array.isArray(result?.results),
        resultsLength: result?.results?.length || 0,
        numFound: result?.numFound,
        count: result?.count,
        resultKeys: result ? Object.keys(result) : [],
        parametersUsed: { 
          countOnly: parameters.countOnly,
          cursorId: parameters.cursorId ? 'provided' : 'not provided'
        }
      });
      
      if (result && typeof result === 'object') {
        const nextCursorId = result.nextCursorId;
        // Check for results in either format (TSV or JSON)
        const hasResults = (Array.isArray(result.results) && result.results.length > 0) ||
                          (result.tsv && typeof result.tsv === 'string' && result.tsv.trim().length > 0);
      
        // Only paginate if there's a nextCursorId and we have results
        if (nextCursorId && nextCursorId !== null && hasResults) {
          // Get first batch count - handle both TSV and JSON formats
          const firstBatchCount = Array.isArray(result.results) 
            ? result.results.length 
            : (result.count || (result.tsv ? result.tsv.split('\n').filter(l => l.trim()).length - 1 : 0));
          
          log.info('Detected query_collection with pagination - starting cursor pagination', {
            toolId,
            firstBatchCount: firstBatchCount,
            totalCount: result.numFound,
            nextCursorId: nextCursorId.substring(0, 20) + '...',
            format: result.tsv ? 'tsv' : 'json'
          });
          
          try {
            // Perform pagination
            result = await paginateQueryCollection(
              toolId,
              parameters,
              result,
              authToken,
              context,
              log
            );
            
            log.info('Pagination completed', {
              toolId,
              totalResults: result.count || (Array.isArray(result.results) ? result.results.length : 0),
              totalCount: result.numFound,
              batches: result._paginationInfo?.totalBatches,
              format: result.tsv ? 'tsv' : 'json'
            });
          } catch (paginationError) {
            // Get first batch count - handle both TSV and JSON formats
            const firstBatchCount = Array.isArray(result.results) 
              ? result.results.length 
              : (result.count || (result.tsv ? result.tsv.split('\n').filter(l => l.trim()).length - 1 : 0));
            
            log.error('Pagination failed, returning first batch only', {
              error: paginationError.message,
              firstBatchCount: firstBatchCount
            });
            // Continue with first batch only - don't throw, let normal flow continue
          }
        } else {
          log.debug('No pagination needed for query_collection', {
            toolId,
            hasNextCursor: !!nextCursorId,
            hasResults: hasResults
          });
        }
      }
      
      // Add query parameters as metadata for query_collection tools
      // Use the actual parameters that were executed (after format override, etc.)
      if (result && typeof result === 'object') {
        // Create a copy of the actual parameters used, excluding internal pagination parameters
        const queryParams = { ...parameters };
        // Remove cursorId as it's an internal pagination parameter
        delete queryParams.cursorId;
        // Store actual query parameters used in result metadata
        result.queryParameters = queryParams;
        log.debug('Added query parameters to result metadata', {
          toolId,
          queryParameters: Object.keys(queryParams),
          format: queryParams.format
        });
      }
    }

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

