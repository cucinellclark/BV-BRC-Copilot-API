// services/mcp/mcpStreamHandler.js

const axios = require('axios');
const { createLogger } = require('../logger');
const { emitSSE } = require('../sseUtils');

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

function isAxiosCancelledError(error) {
  return (
    error?.name === 'CanceledError' ||
    error?.code === 'ERR_CANCELED' ||
    error?.message === 'canceled'
  );
}

function startCancellationWatcher(context, abortController) {
  if (typeof context?.shouldCancel !== 'function') {
    return () => {};
  }
  const interval = setInterval(() => {
    try {
      if (context.shouldCancel() && !abortController.signal.aborted) {
        abortController.abort();
      }
    } catch (_) {
      // Ignore cancellation watcher errors.
    }
  }, 200);
  return () => clearInterval(interval);
}

/**
 * Handle streaming responses from MCP tools
 * Accumulates batches and tracks size/count for threshold decisions
 */
class McpStreamHandler {
  constructor(fileManager) {
    this.fileManager = fileManager;
  }

  /**
   * Check if tool supports streaming based on annotations
   */
  supportsStreaming(toolDef) {
    return toolDef?.annotations?.streamingHint === true;
  }

  /**
   * Check if parameters request streaming
   */
  isStreamingRequested(parameters) {
    return parameters?.stream === true;
  }

  /**
   * Execute tool with streaming support
   * Handles both streaming and non-streaming responses
   */
  async executeWithStreaming(mcpEndpoint, jsonRpcRequest, headers, timeout, context, toolId, log) {
    throwIfCancelled(context, 'before_mcp_request');
    const isStreaming = jsonRpcRequest.params?.arguments?.stream === true;

    if (!isStreaming) {
      // Non-streaming: use regular axios post
      return await this.executeNonStreaming(mcpEndpoint, jsonRpcRequest, headers, timeout, context, log);
    }

    // Streaming: use streaming HTTP client
    return await this.executeStreaming(mcpEndpoint, jsonRpcRequest, headers, timeout, context, toolId, log);
  }

  /**
   * Execute non-streaming request (original behavior)
   */
  async executeNonStreaming(mcpEndpoint, jsonRpcRequest, headers, timeout, context, log) {
    const abortController = new AbortController();
    const stopCancellationWatcher = startCancellationWatcher(context, abortController);
    throwIfCancelled(context, 'before_non_streaming_request');
    try {
      const response = await axios.post(mcpEndpoint, jsonRpcRequest, {
        timeout,
        headers,
        withCredentials: true,
        signal: abortController.signal
      });
      throwIfCancelled(context, 'after_non_streaming_request');

      log.debug('Non-streaming response received');
      return {
        streaming: false,
        data: response.data
      };
    } catch (error) {
      if (isAxiosCancelledError(error) || (typeof context?.shouldCancel === 'function' && context.shouldCancel())) {
        throw createCancellationError('during_non_streaming_request');
      }
      throw error;
    } finally {
      stopCancellationWatcher();
    }
  }

  /**
   * Execute streaming request and accumulate batches
   */
  async executeStreaming(mcpEndpoint, jsonRpcRequest, headers, timeout, context, toolId, log) {
    const abortController = new AbortController();
    const stopCancellationWatcher = startCancellationWatcher(context, abortController);
    log.info('Starting streaming request');
    throwIfCancelled(context, 'before_streaming_request');

    try {
      // Use streaming response type
      const response = await axios.post(mcpEndpoint, jsonRpcRequest, {
        timeout: timeout * 10, // Increase timeout for streaming (10x)
        headers,
        withCredentials: true,
        responseType: 'stream',
        signal: abortController.signal
      });
      throwIfCancelled(context, 'after_streaming_request');

      log.debug('Streaming response received, accumulating batches');

      // Accumulate batches from stream
      const result = await this.accumulateBatches(response.data, context, toolId, log);

      return {
        streaming: true,
        data: result
      };
    } catch (error) {
      if (isAxiosCancelledError(error) || (typeof context?.shouldCancel === 'function' && context.shouldCancel())) {
        throw createCancellationError('during_streaming_request');
      }
      throw error;
    } finally {
      stopCancellationWatcher();
    }
  }

  /**
   * Accumulate batches from stream with size tracking
   */
  async accumulateBatches(stream, context, toolId, log) {
    return new Promise((resolve, reject) => {
      const batches = [];
      let buffer = '';
      let batchCount = 0;
      let totalSize = 0;
      let lastBatch = null;
      let finalToolResult = null;
      let error = null;
      let chunkCount = 0;

      stream.on('data', (chunk) => {
        try {
          throwIfCancelled(context, 'stream_chunk_received');

          chunkCount++;
          const chunkStr = chunk.toString();
          if (chunkCount === 1) {
            console.log(`[MCP Stream Chunk] #${chunkCount} | Full chunk:\n${chunkStr}`);
          } else {
            console.log(`[MCP Stream Chunk] #${chunkCount} | Preview: ${chunkStr.substring(0, 50)}`);
          }
          buffer += chunkStr;

          // Split on newlines - each SSE event is separated
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            throwIfCancelled(context, 'stream_line_processed');

            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            // Skip SSE comment lines (keepalive pings: ": ping - timestamp")
            if (trimmedLine.startsWith(':')) {
              continue;
            }

            // Skip SSE event type lines (e.g., "event: message")
            if (trimmedLine.startsWith('event:')) {
              continue;
            }

            // Parse SSE format: "data: {...}"
            let data = trimmedLine;
            if (trimmedLine.startsWith('data:')) {
              data = trimmedLine.slice(5).trim();
            }

            if (!data || data === '[DONE]') continue;

            try {
              // Try parsing the data
              let parsed = null;
              try {
                parsed = JSON.parse(data);
              } catch (parseErr) {
                console.log(`[MCP Stream] Failed to parse as JSON:`, {
                  error: parseErr.message,
                  dataPreview: data.substring(0, 200)
                });
                continue;
              }

              // Forward MCP progress notifications to client SSE stream.
              if (parsed && parsed.method === 'notifications/progress' && parsed.params) {
                const progress = Number(parsed.params.progress) || 0;
                const total = Number.isFinite(Number(parsed.params.total))
                  ? Number(parsed.params.total)
                  : null;
                const percentage = total && total > 0
                  ? Math.floor((progress / total) * 100)
                  : null;
                if (context?.responseStream) {
                  emitSSE(context.responseStream, 'query_progress', {
                    tool: toolId,
                    current: progress,
                    total: total,
                    percentage: percentage,
                    message: parsed.params.message || null,
                    timestamp: new Date().toISOString()
                  });
                }
                continue;
              }

              // FastMCP wraps generator yields in JSON-RPC format
              // Structure: { jsonrpc: "2.0", id: "...", result: "..." }
              // Where result is a JSON string that needs parsing
              let batch = null;
              
              if (parsed && parsed.jsonrpc === '2.0' && parsed.result !== undefined) {
                // It's a JSON-RPC response
                if (typeof parsed.result === 'string') {
                  // Result is a JSON string, parse it
                  try {
                    batch = JSON.parse(parsed.result);
                  } catch (innerErr) {
                    console.log(`[MCP Stream] Failed to parse result JSON string:`, {
                      error: innerErr.message,
                      resultPreview: parsed.result.substring(0, 200)
                    });
                    continue;
                  }
                } else {
                  // Result is already an object
                  batch = parsed.result;
                }
                if (
                  batch &&
                  typeof batch === 'object' &&
                  (batch.content || batch.structuredContent || batch.isError !== undefined)
                ) {
                  // Final FastMCP tool result wrapper. Keep it as-is so executor can
                  // run normal unwrapMcpContent processing downstream.
                  finalToolResult = batch;
                  continue;
                }
              } else if (parsed && (parsed.results !== undefined || parsed.batchNumber !== undefined || parsed.count !== undefined)) {
                // Direct batch object (not wrapped in JSON-RPC)
                batch = parsed;
              } else {
                // Unknown format, log and skip
                console.log(`[MCP Stream] Unknown data format, skipping:`, {
                  keys: Object.keys(parsed || {}),
                  hasJsonrpc: parsed?.jsonrpc,
                  hasResult: parsed?.result !== undefined,
                  dataPreview: JSON.stringify(parsed).substring(0, 200)
                });
                continue;
              }

              // Validate batch structure
              if (!batch || typeof batch !== 'object') {
                console.log(`[MCP Stream] Invalid batch structure:`, {
                  type: typeof batch,
                  isNull: batch === null
                });
                continue;
              }

            // Check for FastMCP error format: { "content": [...], "isError": true }
            if (batch.isError === true && batch.content) {
              const errorMessage = batch.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join(' ');
              error = {
                error: errorMessage || 'MCP tool returned an error',
                mcpError: true
              };
              console.log(`[MCP Stream] FastMCP error received:`, {
                error: errorMessage,
                fullError: batch
              });
              log.error('FastMCP error received', { error: errorMessage });
              stream.destroy();
              return;
            }

            // Check for error in batch (standard format)
            if (batch.error) {
              error = {
                error: batch.error,
                batchNumber: batch.batchNumber
              };
              console.log(`[MCP Stream] Error batch received:`, {
                error: batch.error,
                batchNumber: batch.batchNumber
              });
              log.error('Error batch received', { error: batch.error });
              stream.destroy();
              return;
            }

              // Track batch
              batches.push(batch);
              batchCount++;
              lastBatch = batch;

              console.log(`[MCP Stream] Received batch ${batchCount}:`, {
                batchNumber: batch.batchNumber,
                count: batch.count,
                cumulativeCount: batch.cumulativeCount,
                done: batch.done,
                hasResults: !!batch.results,
                resultsLength: batch.results?.length || 0,
                totalBatchesSoFar: batchCount,
                batchKeys: Object.keys(batch),
                rawBatch: JSON.stringify(batch).substring(0, 200) // First 200 chars for debugging
              });

              log.debug(`Received batch ${batchCount}`, {
                batchNumber: batch.batchNumber,
                count: batch.count,
                cumulativeCount: batch.cumulativeCount
              });

              // Update size estimate
              if (batch.results) {
                totalSize += Buffer.byteLength(JSON.stringify(batch.results));
              }

              // Check if done
              if (batch.done) {
                log.info('Streaming complete', {
                  totalBatches: batchCount,
                  totalResults: batch.cumulativeCount
                });
                stream.destroy();
              }

            } catch (parseError) {
              // Only log if it's not an empty line or event line
              if (trimmedLine && !trimmedLine.startsWith('event:')) {
                console.log(`[MCP Stream] Failed to parse batch:`, {
                  error: parseError.message,
                  line: trimmedLine.substring(0, 100), // First 100 chars
                  lineLength: trimmedLine.length
                });
                log.warn('Failed to parse batch', { 
                  error: parseError.message, 
                  line: trimmedLine.substring(0, 100),
                  lineLength: trimmedLine.length
                });
              }
            }
          }
        } catch (err) {
          if (err?.isCancelled) {
            try {
              stream.destroy(err);
            } catch (_) {
              // Ignore stream destroy errors on cancellation.
            }
          }
          log.error('Error processing chunk', { error: err.message });
          reject(err);
        }
      });

      stream.on('end', () => {
        if (error) {
          if (error.isCancelled) {
            reject(error);
            return;
          }

          // Return error information
          const errorResult = {
            error: error.error || 'Stream error',
            partial: error.mcpError ? false : true,
            batchesReceived: batchCount,
            totalResults: lastBatch?.cumulativeCount || 0,
            mcpError: error.mcpError || false
          };
          console.log(`[MCP Stream] Stream ended with error:`, errorResult);
          resolve(errorResult);
        } else if (batches.length === 0) {
          if (finalToolResult) {
            resolve(finalToolResult);
            return;
          }
          // No batches received
          console.log(`[MCP Stream] Stream ended with no batches`);
          resolve({
            error: 'No data batches received from stream',
            results: [],
            count: 0,
            numFound: 0,
            source: 'bvbrc-mcp-data'
          });
        } else {
          // Merge all batches into single result
          const mergedResult = this.mergeBatches(batches, batchCount, totalSize, log);
          resolve(mergedResult);
        }
      });

      stream.on('error', (err) => {
        if (err && err.isCancelled) {
          reject(err);
          return;
        }

        log.error('Stream error', { error: err.message });
        
        // Return partial results if we got any
        if (batches.length > 0) {
          const mergedResult = this.mergeBatches(batches, batchCount, totalSize, log);
          mergedResult.partial = true;
          mergedResult.error = `Stream error: ${err.message}`;
          resolve(mergedResult);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Merge accumulated batches into single result
   * Extracts only the results arrays from all batches and combines them
   * Removes all batch metadata (batchNumber, count, cumulativeCount, done, etc.)
   */
  mergeBatches(batches, batchCount, totalSize, log) {
    if (batches.length === 0) {
      return {
        results: [],
        count: 0,
        numFound: 0,
        source: 'bvbrc-mcp-data'
      };
    }

    // Extract all results from batches - merge all results arrays
    const allResults = [];
    for (const batch of batches) {
      const batchText = batch.content[0].text;
      const textJson = JSON.parse(batchText);
      for (const br of textJson) {
        const batchRecord = JSON.parse(br);
        if (batchRecord.results && Array.isArray(batchRecord.results)) {
          allResults.push(...batchRecord.results);
        }
      }
    }
    console.log(`allResults.length: ${allResults.length}`);

    const lastBatch = batches[batches.length - 1];

    log.info('Merged batches', {
      totalBatches: batchCount,
      totalResults: allResults.length,
      estimatedSize: totalSize,
      numFound: lastBatch.numFound
    });

    // Return only the essential fields - no batch metadata
    // Include batchCount for internal threshold decisions (prefixed with _ to indicate internal)
    const merged = {
      results: allResults,
      count: allResults.length,
      numFound: lastBatch.numFound || allResults.length,
      source: 'bvbrc-mcp-data'
    };
    
    // Add batchCount as internal metadata (won't be saved to file)
    merged._batchCount = batchCount;
    
    return merged;
  }
}

module.exports = { McpStreamHandler };

