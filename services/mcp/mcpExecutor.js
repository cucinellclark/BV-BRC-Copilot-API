// services/mcp/mcpExecutor.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getToolDefinition, loadToolsManifest } = require('./toolDiscovery');
const { sessionManager } = require('./mcpSessionManager');
const { McpStreamHandler } = require('./mcpStreamHandler');
const { fileManager } = require('../fileManager');
const { createLogger } = require('../logger');
const { emitSSE } = require('../sseUtils');
const { isContextAwareTool, applyContextEnhancement } = require('./contextAwareTools');
const { workspaceService } = require('../workspaceService');

// Initialize stream handler
const streamHandler = new McpStreamHandler(fileManager);
const config = require('./config.json');

const DEFAULT_RAG_FRAGMENTS = ['helpdesk_service_usage'];
const LOCAL_SESSION_BASE_PATH = '/tmp/copilot/sessions';
const WORKSPACE_PATH_IN_CODE_REGEX = /\/[^/\s"'`]+\/home\/(?:CopilotDownloads|CopilotCodeDev)\/[^\s"'`]+/g;

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

function isRunPythonCodeTool(toolId) {
  if (!toolId) return false;
  return toolId === 'run_python_code' || toolId.endsWith('.run_python_code') || toolId.includes('run_python_code');
}

function findWorkspacePathsInCode(code = '') {
  if (typeof code !== 'string' || !code) return [];
  return Array.from(new Set(code.match(WORKSPACE_PATH_IN_CODE_REGEX) || []));
}

function rewriteWorkspacePathsToLocalTmp(code = '', sessionId = null, logger = console) {
  if (typeof code !== 'string' || !code) {
    return { code, replacements: 0, unresolved: [] };
  }

  const workspacePaths = findWorkspacePathsInCode(code);
  if (workspacePaths.length === 0) {
    return { code, replacements: 0, unresolved: [] };
  }

  let rewritten = code;
  let replacements = 0;
  const unresolved = [];

  for (const workspacePath of workspacePaths) {
    const fileName = path.basename(workspacePath);
    if (!sessionId || !fileName) {
      unresolved.push(workspacePath);
      continue;
    }

    const localTmpPath = path.join(LOCAL_SESSION_BASE_PATH, sessionId, 'downloads', fileName);
    rewritten = rewritten.split(workspacePath).join(localTmpPath);
    replacements += 1;

    if (!fs.existsSync(localTmpPath)) {
      logger.warn('[MCP] Rewrote workspace path to session local tmp path, but file does not currently exist', {
        workspacePath,
        localTmpPath,
        sessionId
      });
    }
  }

  const remainingWorkspacePaths = findWorkspacePathsInCode(rewritten);
  return {
    code: rewritten,
    replacements,
    unresolved: [...unresolved, ...remainingWorkspacePaths]
  };
}

function createCancellationError(checkpoint = 'unknown') {
  const error = new Error(`Job cancelled by user (${checkpoint})`);
  error.name = 'JobCancelledError';
  error.isCancelled = true;
  return error;
}

function throwIfCancelled(context = {}, checkpoint = 'unknown') {
  if (typeof context?.shouldCancel === 'function' && context.shouldCancel()) {
    throw createCancellationError(checkpoint);
  }
}

/**
 * Apply server-side overrides for parameters that should NOT be controlled by the LLM.
 *
 * Today this is primarily used to bind "internal_server.*" file tools to the current
 * Copilot chat session. Those tools operate on files stored under:
 *   /tmp/copilot/sessions/{session_id}/downloads
 *
 * Letting the LLM supply session_id is fragile (it may invent "default").
 * We always force it from the trusted execution context.
 */
function applySystemParameterOverrides(toolId, parameters = {}, context = {}, log = null, toolDef = null) {
  const safeParams = (parameters && typeof parameters === 'object') ? { ...parameters } : {};

  // Create a safe logger wrapper that falls back to console if log is null
  const logger = log || {
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    info: (...args) => console.info(...args),
    debug: (...args) => console.debug(...args)
  };

  // Check if tool schema accepts session_id (for any server, not just internal_server)
  if (toolId && context?.session_id && toolDef?.inputSchema?.properties) {
    const acceptsSessionId = !!(
      Object.prototype.hasOwnProperty.call(toolDef.inputSchema.properties, 'session_id')
    );

    if (acceptsSessionId) {
      const provided = safeParams.session_id;
      if (provided && provided !== context.session_id) {
        logger.warn('[MCP] Overriding tool session_id from untrusted parameters', {
          toolId,
          providedSessionId: provided,
          forcedSessionId: context.session_id
        });
      }
      safeParams.session_id = context.session_id;
    } else {
      // If the LLM provided it anyway but tool doesn't accept it, strip it to avoid breaking the tool call.
      if (safeParams.session_id !== undefined) {
        logger.warn('[MCP] Removing unsupported session_id parameter for tool', {
          toolId
        });
        delete safeParams.session_id;
      }
    }
  }

  // Override path parameter for workspace_browse_tool to ensure first segment is the actual user_id
  // Extract user_id from auth token to get the full email address (e.g., user@patricbrc.org)
  if (toolId && toolId.includes('workspace_browse_tool') && safeParams.path) {
    const originalPath = safeParams.path;

    // Extract user_id from auth token (authoritative source)
    const authToken = context?.authToken || context?.auth_token;
    console.log('authToken', authToken);
    let actualUserId = null;

    if (authToken) {
      actualUserId = workspaceService.extractUserId(authToken);
    }
    console.log('actualUserId', actualUserId);
    // Fallback to context.user_id if token extraction fails
    if (!actualUserId && context?.user_id) {
      actualUserId = context.user_id;
    }

    if (actualUserId) {
      // Parse the path to extract segments
      // Path format: /user1@patricbrc.org/home/Genome Groups or /user1@patricbrc.org/
      // IMPORTANT: The @ symbol in email addresses should NOT be split on, only split on /
      const hasTrailingSlash = originalPath.endsWith('/');

      // Split by '/' and get the first segment (the user_id part)
      const pathParts = originalPath.split('/');

      // pathParts[0] is empty (before the leading /), pathParts[1] is the user_id
      if (pathParts.length > 1 && pathParts[1]) {
        // Replace the first path segment with the actual user_id extracted from token
        pathParts[1] = actualUserId;

        // Reconstruct the path, preserving trailing slash
        const correctedPath = pathParts.join('/') + (hasTrailingSlash && !pathParts[pathParts.length - 1] ? '' : hasTrailingSlash ? '/' : '');

        if (correctedPath !== originalPath) {
          logger.info('[MCP] Overriding workspace_browse_tool path with actual user_id from token', {
            toolId,
            originalPath,
            correctedPath,
            tokenExtractedUserId: actualUserId,
            contextUserId: context.user_id || 'not provided'
          });
          safeParams.path = correctedPath;
        }
      }
    } else {
      logger.warn('[MCP] Could not extract user_id for workspace_browse_tool path override', {
        toolId,
        hasAuthToken: !!authToken,
        hasContextUserId: !!context?.user_id
      });
    }

    // Sanitize list-type parameters: convert empty strings to null
    // The MCP server expects these to be arrays or null, not empty strings
    const listParams = ['filename_search_terms', 'file_extension', 'file_types'];
    for (const param of listParams) {
      if (safeParams[param] === '' || safeParams[param] === 'null' || safeParams[param] === 'undefined') {
        logger.info('[MCP] Sanitizing list parameter for workspace_browse_tool', {
          param,
          originalValue: safeParams[param],
          newValue: null
        });
        safeParams[param] = null;
      }
    }
  }

  // Enforce local tmp paths for run_python_code input.
  // The Python runtime can only read local filesystem paths (e.g. /tmp/...),
  // not remote workspace identifiers like /<user>/home/CopilotDownloads/...
  if (isRunPythonCodeTool(toolId) && typeof safeParams.code === 'string') {
    const rewriteResult = rewriteWorkspacePathsToLocalTmp(
      safeParams.code,
      context?.session_id || null,
      logger
    );

    if (rewriteResult.replacements > 0) {
      logger.info('[MCP] Rewrote workspace paths in run_python_code input to local tmp paths', {
        toolId,
        replacements: rewriteResult.replacements,
        sessionId: context?.session_id || null
      });
      safeParams.code = rewriteResult.code;
    }

    if (rewriteResult.unresolved.length > 0) {
      throw new Error(
        `run_python_code input contains workspace paths. Use local tmp paths only (e.g. /tmp/copilot/sessions/${context?.session_id || '<session_id>'}/downloads/<file>).`
      );
    }
    
    // CRITICAL: Always inject session_id for run_python_code
    // The MCP server needs this to bind the session directory to the Singularity container
    if (context?.session_id) {
      const provided = safeParams.session_id;
      if (provided && provided !== context.session_id) {
        logger.warn('[MCP] Overriding run_python_code session_id from untrusted parameters', {
          toolId,
          providedSessionId: provided,
          forcedSessionId: context.session_id
        });
      }
      safeParams.session_id = context.session_id;
      logger.debug('[MCP] Injected session_id into run_python_code parameters', {
        toolId,
        sessionId: context.session_id
      });
    } else {
      logger.warn('[MCP] No session_id in context for run_python_code - tool may fail', {
        toolId
      });
    }
  }

  // Apply context-aware enhancement for tools that need conversational context
  if (isContextAwareTool(toolId)) {
    const enhancedParams = applyContextEnhancement(toolId, safeParams, context, toolDef, logger);
    Object.assign(safeParams, enhancedParams);
  }

  return safeParams;
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

  // Check for FastMCP format: content array with type "text" and text field containing JSON
  if (result.content && Array.isArray(result.content) && result.content.length > 0) {
    const firstContent = result.content[0];
    if (firstContent.type === 'text' && firstContent.text) {
      try {
        const trimmed = firstContent.text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(firstContent.text);
        }
        // Not JSON, return as string
        return firstContent.text;
      } catch (parseError) {
        // If parsing fails, return the string as-is
        return firstContent.text;
      }
    }
  }

  // Check if result.result exists and is a JSON string (some MCP servers wrap this way)
  if (result.result !== undefined) {
    if (typeof result.result === 'string') {
      try {
        const trimmed = result.result.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(result.result);
        }
        // Not JSON-like, return as string
        return result.result;
      } catch (parseError) {
        // If parsing fails, return the string as-is
        return result.result;
      }
    } else if (typeof result.result === 'object' && result.result !== null) {
      // If result.result is already an object, return it directly
      return result.result;
    } else {
      // For other types (boolean, number, etc), return as-is
      return result.result;
    }
  }

  // No wrapper detected, return as-is
  return result;
}

function normalizeRagResult(rawResult, maxDocs = 5) {
  // Debug: log the raw result structure to diagnose issues
  if (!rawResult || typeof rawResult !== 'object') {
    console.warn('[normalizeRagResult] Invalid rawResult:', { type: typeof rawResult, rawResult });
    return {
      type: 'rag_result',
      count: 0,
      documents: [],
      source: 'bvbrc-rag',
      error: 'Invalid result structure'
    };
  }

  // Try multiple possible field names for documents
  let docs = [];

  // Helper function to safely parse JSON strings
  const parseIfString = (value) => {
    if (typeof value === 'string') {
      try {
        const trimmed = value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : null;
        }
      } catch (e) {
        // Not valid JSON, return null
      }
    }
    return null;
  };

  if (rawResult.used_documents) {
    if (Array.isArray(rawResult.used_documents)) {
      docs = rawResult.used_documents;
    } else {
      const parsed = parseIfString(rawResult.used_documents);
      if (parsed) docs = parsed;
    }
  }

  if (docs.length === 0 && rawResult.results) {
    if (Array.isArray(rawResult.results)) {
      docs = rawResult.results;
    } else {
      const parsed = parseIfString(rawResult.results);
      if (parsed) docs = parsed;
    }
  }

  if (docs.length === 0 && rawResult.documents) {
    if (Array.isArray(rawResult.documents)) {
      docs = rawResult.documents;
    } else {
      const parsed = parseIfString(rawResult.documents);
      if (parsed) docs = parsed;
    }
  }

  if (docs.length === 0 && Array.isArray(rawResult)) {
    // If the result itself is an array, use it directly
    docs = rawResult;
  }

  // If we still don't have docs, log what we do have for debugging
  if (docs.length === 0 && (rawResult.count > 0 || rawResult.results || rawResult.used_documents)) {
    console.warn('[normalizeRagResult] No documents found but count > 0 or results exist:', {
      count: rawResult.count,
      hasResults: !!rawResult.results,
      resultsType: typeof rawResult.results,
      resultsIsArray: Array.isArray(rawResult.results),
      resultsPreview: typeof rawResult.results === 'string' ? rawResult.results.substring(0, 200) : 'N/A',
      hasUsedDocuments: !!rawResult.used_documents,
      usedDocumentsType: typeof rawResult.used_documents,
      usedDocumentsIsArray: Array.isArray(rawResult.used_documents),
      resultKeys: Object.keys(rawResult),
      rawResultPreview: JSON.stringify(rawResult).substring(0, 1000)
    });
  }

  const limitedDocs = docs.slice(0, maxDocs);

  return {
    type: 'rag_result',
    query: rawResult.query,
    index: rawResult.index,
    count: rawResult.count ?? limitedDocs.length,
    summary: rawResult.summary,
    documents: limitedDocs,
    source: rawResult.source || 'bvbrc-rag'
  };
}

/**
 * Check if tool supports cursor-based pagination in the executor
 */
function isQueryCollectionTool(toolId) {
  if (!toolId) return false;
  // Match both 'tool_name' and 'server.tool_name' formats
  return toolId === 'bvbrc_query_collection' || toolId.endsWith('.bvbrc_query_collection') ||
         toolId === 'bvbrc_global_data_search' || toolId.endsWith('.bvbrc_global_data_search');
}

/**
 * Check if tool should force TSV format
 */
function shouldForceTsvFormat(toolId) {
  if (!toolId) return false;
  // Match both 'tool_name' and 'server.tool_name' formats
  return toolId === 'bvbrc_query_collection' || toolId.endsWith('.bvbrc_query_collection') ||
         toolId === 'bvbrc_global_data_search' || toolId.endsWith('.bvbrc_global_data_search');
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
  throwIfCancelled(context, 'before_pagination_start');

  // Check if pagination is needed
  const nextCursorId = firstResponse?.nextCursorId;
  const totalCount = firstResponse?.numFound || firstResponse?.count || 0;
  const requestedLimit = Number.isInteger(originalParameters?.limit) && originalParameters.limit > 0
    ? originalParameters.limit
    : null;

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

  if (requestedLimit !== null && !isTsvFormat && allResults.length > requestedLimit) {
    allResults = allResults.slice(0, requestedLimit);
    currentCount = allResults.length;
  }

  if (requestedLimit !== null && isTsvFormat) {
    const tsvLines = allTsv.split('\n').filter(line => line.trim().length > 0);
    if (tsvLines.length > 0) {
      const header = tsvLines[0];
      const dataLines = tsvLines.slice(1, requestedLimit + 1);
      allTsv = [header, ...dataLines].join('\n') + (dataLines.length > 0 ? '\n' : '');
      currentCount = dataLines.length;
    }
  }

  let batchNumber = 1;
  let cursor = (requestedLimit !== null && currentCount >= requestedLimit) ? null : nextCursorId;
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
      throwIfCancelled(context, `before_pagination_batch_${batchNumber}`);

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

      throwIfCancelled(context, `after_pagination_batch_${batchNumber}_response`);

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

      // Respect caller-provided limit (used by global search in Copilot flow).
      if (requestedLimit !== null && currentCount >= requestedLimit) {
        if (isTsvFormat) {
          const tsvLines = allTsv.split('\n').filter(line => line.trim().length > 0);
          if (tsvLines.length > 0) {
            const header = tsvLines[0];
            const dataLines = tsvLines.slice(1, requestedLimit + 1);
            allTsv = [header, ...dataLines].join('\n') + (dataLines.length > 0 ? '\n' : '');
            currentCount = dataLines.length;
          }
        } else if (isJsonFormat) {
          allResults = allResults.slice(0, requestedLimit);
          currentCount = allResults.length;
        } else {
          currentCount = requestedLimit;
        }
        log.info('Pagination limit reached, stopping further cursor fetches', {
          toolId,
          requestedLimit,
          currentCount
        });
        cursor = null;
      }

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
      if (cursor !== null) {
        cursor = nextCursor;
      }

      // Break if no more pages
      if (!cursor || cursor === null) {
        log.info('Pagination complete - no more pages', {
          totalBatches: batchNumber,
          totalResults: currentCount
        });
        break;
      }

    } catch (error) {
      if (error && error.isCancelled) {
        throw error;
      }

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
 * Execute an MCP tool
 *
 * @param {string} toolId - Full tool ID (e.g., "bvbrc_server.query_collection")
 * @param {object} parameters - Tool parameters
 * @param {string} authToken - Authentication token
 * @param {object} context - Additional context (query, model, etc.)
 * @param {Logger} logger - Optional logger instance
 * @returns {Promise<object>} Tool execution result
 */
async function executeMcpTool(toolId, parameters = {}, authToken = null, context = {}, logger = null) {
  const log = logger || createLogger('MCP-Executor', context.session_id);

  try {
    throwIfCancelled(context, 'before_tool_definition');

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

    // Never trust the LLM with certain IDs (e.g., internal_server session_id)
    // Apply overrides AFTER resolving tool definition so we can honor the schema.
    // Include authToken in context for parameter overrides
    const contextWithAuth = {
      ...context,
      authToken: authToken || context.authToken || context.auth_token
    };
    parameters = applySystemParameterOverrides(toolId, parameters, contextWithAuth, log, toolDef);

    log.info(`Executing tool: ${toolId}`, { parameters });

    // Get server config
    const serverKey = toolDef.server;
    const serverConfig = config.servers[serverKey];
    if (!serverConfig) {
      throw new Error(`Server configuration not found for: ${serverKey}`);
    }

    // Get or create session
    throwIfCancelled(context, 'before_get_or_create_session');
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
    }

    // Force TSV format for tools that require it
    if (shouldForceTsvFormat(toolId)) {
      if (parameters.format !== 'tsv') {
        log.info('Overriding format parameter - forcing TSV format', {
          toolId,
          originalFormat: parameters.format
        });
        parameters.format = 'tsv';
      }
    }

    if (!isQueryCollectionTool(toolId)) {
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
    throwIfCancelled(context, 'before_tool_execution');
    const executionResult = await streamHandler.executeWithStreaming(
      mcpEndpoint,
      jsonRpcRequest,
      headers,
      timeout,
      context,
      toolId,
      log
    );
    throwIfCancelled(context, 'after_tool_execution');

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
        log.debug('Parsing SSE format response', {
          stringPreview: responseData.substring(0, 200)
        });

        // SSE format: "event: message\r\ndata: {...}\r\n"
        // Extract the data line
        const lines = responseData.split(/\r?\n/);
        let dataLine = null;

        for (const line of lines) {
          if (line.trim().startsWith('data:')) {
            dataLine = line.trim().substring(5).trim(); // Remove "data:" prefix
            break;
          }
        }

        if (dataLine) {
          try {
            responseData = JSON.parse(dataLine);
            log.debug('Successfully parsed SSE data line', {
              hasResult: !!responseData?.result,
              hasContent: !!responseData?.content,
              keys: Object.keys(responseData || {})
            });
          } catch (parseError) {
            log.error('Failed to parse SSE data line as JSON', {
              error: parseError.message,
              dataLinePreview: dataLine.substring(0, 200)
            });
          }
        } else {
          log.warn('No data line found in SSE response', {
            responsePreview: responseData.substring(0, 200)
          });
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

    // DEBUG: Log responseData structure
    log.info('ResponseData structure before extracting result', {
      toolId,
      isStreamingResponse,
      responseDataType: typeof responseData,
      responseDataKeys: responseData && typeof responseData === 'object' ? Object.keys(responseData) : 'N/A',
      hasResult: responseData?.result !== undefined,
      hasContent: !!responseData?.content,
      hasStructuredContent: !!responseData?.structuredContent,
      responseDataPreview: responseData ? JSON.stringify(responseData).substring(0, 500) : 'null/undefined'
    });

    let result = isStreamingResponse ? responseData : responseData.result;
    log.info('Tool executed successfully', {
      toolId,
      isStreamingResponse
    });

    // DEBUG: Log raw result structure before unwrapping
    log.info('Raw result structure before unwrapping', {
      toolId,
      resultType: typeof result,
      isNull: result === null,
      isUndefined: result === undefined,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : 'N/A',
      hasContent: !!result?.content,
      hasStructuredContent: !!result?.structuredContent,
      hasResult: !!result?.result,
      rawResultPreview: result ? JSON.stringify(result).substring(0, 500) : 'null/undefined'
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
            throwIfCancelled(context, 'before_paginate_query_collection');
            result = await paginateQueryCollection(
              toolId,
              parameters,
              result,
              authToken,
              context,
              log
            );
            throwIfCancelled(context, 'after_paginate_query_collection');

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

    // Attach normalized call metadata so clients can replay selected queries.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const replayable =
        isQueryCollectionTool(toolId) ||
        toolId.includes('workspace_browse_tool') ||
        toolId.includes('list_jobs');
      if (!result.call || typeof result.call !== 'object') {
        result.call = {
          tool: toolId,
          arguments_executed: { ...parameters },
          replayable
        };
      } else if (result.call.replayable === undefined) {
        result.call.replayable = replayable;
      }
    }

    // Special-case RAG tools: normalize and limit documents
    if (isRagTool(toolId)) {
      log.info('Processing RAG tool result', {
        toolId,
        source: result?.source,
        count: result?.count,
        hasResults: !!result?.results,
        resultsType: typeof result?.results,
        resultsIsArray: Array.isArray(result?.results),
        resultsLength: Array.isArray(result?.results) ? result.results.length : 'N/A',
        hasUsedDocuments: !!result?.used_documents,
        usedDocumentsType: typeof result?.used_documents,
        usedDocumentsIsArray: Array.isArray(result?.used_documents),
        hasSummary: !!result?.summary,
        resultKeys: result ? Object.keys(result) : [],
        resultPreview: result ? JSON.stringify(result).substring(0, 1000) : 'null'
      });

      const normalized = normalizeRagResult(result, config.global_settings?.rag_max_docs);
      log.info('RAG result normalized', {
        type: normalized.type,
        documentsCount: normalized.documents?.length,
        count: normalized.count,
        hasSummary: !!normalized.summary,
        source: normalized.source
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
    if (error && error.isCancelled) {
      throw error;
    }

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

