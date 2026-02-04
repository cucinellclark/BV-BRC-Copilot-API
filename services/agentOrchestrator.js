// services/agentOrchestrator.js

const { v4: uuidv4 } = require('uuid');
const { executeMcpTool, isFinalizeTool, isRagTool } = require('./mcp/mcpExecutor');
const { loadToolsForPrompt } = require('./mcp/toolDiscovery');
const { 
  getModelData, 
  getChatSession, 
  createChatSession,
  addMessagesToSession 
} = require('./dbUtils');
const { 
  queryChatOnly, 
  LLMServiceError,
  setupOpenaiClient,
  postJsonStream
} = require('./llmServices');
const { safeParseJson } = require('./jsonUtils');
const promptManager = require('../prompts');
const mcpConfig = require('./mcp/config.json');
const { createLogger } = require('./logger');
const fs = require('fs').promises;
const { emitSSE: emitSSEUtil } = require('./sseUtils');
const { buildConversationContext } = require('./memory/conversationContextService');
const { maybeQueueSummary } = require('./summaryQueueService');

function prepareToolResult(toolId, result, ragMaxDocs = 5) {
  // Check if this is a RAG result (has documents and summary)
  const isRagResult = result && result.documents && result.summary;
  
  if (isRagResult) {
    const docs = Array.isArray(result.documents) ? result.documents.slice(0, ragMaxDocs) : [];
    const count = result.count ?? docs.length;

    return {
      storage: {
        tool: toolId,
        query: result.query,
        index: result.index,
        summary: result.summary,
        count,
        documents: docs
      },
      safeResult: {
        type: 'rag_result',
        query: result.query,
        index: result.index,
        count,
        summary: result.summary,
        documents_included: false,
        documents_count: docs.length
      }
    };
  }

  return { storage: null, safeResult: result };
}

/**
 * Helper function to create message objects with consistent structure
 */
function createMessage(role, content) {
  return {
    message_id: uuidv4(),
    role,
    content,
    timestamp: new Date()
  };
}

// Use shared emitSSE from sseUtils
const emitSSE = emitSSEUtil;

/**
 * Normalize parameters for consistent comparison
 * Handles empty strings, null, undefined, whitespace, and boolean strings
 */
function normalizeParameters(params) {
  if (!params || typeof params !== 'object') {
    return params;
  }
  
  const normalized = {};
  const keys = Object.keys(params).sort(); // Sort keys for consistent comparison
  
  for (const key of keys) {
    let value = params[key];
    
    // Normalize empty strings, null, undefined to null
    if (value === '' || value === null || value === undefined) {
      normalized[key] = null;
    }
    // Normalize string values
    else if (typeof value === 'string') {
      // Trim whitespace
      value = value.trim();
      // Normalize boolean strings
      if (value === 'true') {
        normalized[key] = true;
      } else if (value === 'false') {
        normalized[key] = false;
      } else if (value === '') {
        normalized[key] = null;
      } else {
        normalized[key] = value;
      }
    }
    // Recursively normalize nested objects
    else if (typeof value === 'object' && !Array.isArray(value)) {
      normalized[key] = normalizeParameters(value);
    }
    // Keep other types as-is
    else {
      normalized[key] = value;
    }
  }
  
  return normalized;
}

/**
 * Deep equality check for objects
 */
function deepEquals(obj1, obj2) {
  if (obj1 === obj2) return true;
  
  if (obj1 == null || obj2 == null) return obj1 === obj2;
  
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object') {
    return obj1 === obj2;
  }
  
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  
  if (keys1.length !== keys2.length) return false;
  
  for (const key of keys1) {
    if (!keys2.includes(key)) return false;
    if (!deepEquals(obj1[key], obj2[key])) return false;
  }
  
  return true;
}

/**
 * Check if a planned action is a duplicate of a previously executed action
 * Returns an object with isDuplicate flag and details
 */
function isDuplicateAction(plannedAction, executionTrace) {
  if (!plannedAction || !plannedAction.action) {
    return { isDuplicate: false };
  }
  
  // Only track duplicates for actions where re-running is costly or redundant
  const duplicateTrackedActions = new Set([
    'bvbrc_server.query_collection'
  ]);

  if (!duplicateTrackedActions.has(plannedAction.action)) {
    return { isDuplicate: false };
  }

  // Don't check FINALIZE actions
  if (plannedAction.action === 'FINALIZE') {
    return { isDuplicate: false };
  }
  
  const normalizedPlanned = normalizeParameters(plannedAction.parameters);
  
  // Check against all successful past actions
  for (const pastAction of executionTrace) {
    // Only check successful actions
    if (pastAction.status !== 'success') {
      continue;
    }
    
    // Check if action names match
    if (pastAction.action === plannedAction.action) {
      const normalizedPast = normalizeParameters(pastAction.parameters);
      
      // Check if parameters are identical
      if (deepEquals(normalizedPlanned, normalizedPast)) {
        return {
          isDuplicate: true,
          duplicateIteration: pastAction.iteration,
          action: pastAction.action,
          message: `This exact action was already executed successfully in iteration ${pastAction.iteration}`,
          previousResult: pastAction.result
        };
      }
    }
  }
  
  return { isDuplicate: false };
}

/**
 * Check if there are sufficient results to answer the query
 */
function hasSufficientData(toolResults) {
  if (!toolResults || Object.keys(toolResults).length === 0) {
    return false;
  }
  
  // Check if we have any file references with data
  for (const result of Object.values(toolResults)) {
    if (result && result.type === 'file_reference' && result.summary) {
      // Has data if recordCount > 0
      if (result.summary.recordCount && result.summary.recordCount > 0) {
        return true;
      }
    }
    // Check for other result types (should be rare now that all results are file references)
    else if (result && typeof result === 'object' && !result.error) {
      return true;
    }
  }
  
  return false;
}

/**
 * Main agent orchestrator - executes iterative task loop
 * 
 * @param {object} opts - Options object
 * @returns {Promise<object>} Final response with execution trace
 */
async function executeAgentLoop(opts) {
  const {
    query,
    model,
    session_id,
    user_id,
    system_prompt = '',
    save_chat = true,
    include_history = true,
    max_iterations = 8,
    auth_token = null,
    stream = false,
    responseStream = null
  } = opts;
  
  // Create logger for this session
  const logger = createLogger('Agent', session_id);
  
  // Start a new query (this will increment the query counter and create Query A, B, C, etc.)
  const queryId = logger.startNewQuery();
  
  logger.info('Starting agent loop', { 
    queryId,
    query, 
    model, 
    session_id, 
    user_id, 
    max_iterations 
  });
  
  const executionTrace = [];
  const toolResults = {};
  const collectedRagDocs = [];
  let iteration = 0;
  let finalResponseSourceTool = null; // Track which tool generated the final response
  let finalResponse = null;
  
  // Get auth token (from opts or config)
  const authToken = auth_token || mcpConfig.auth_token;
  
  // Get or create chat session
  let chatSession = null;
  let historyContext = '';
  if (session_id) {
    chatSession = await getChatSession(session_id);
    if (include_history && chatSession?.messages) {
      logger.info(`Loaded ${chatSession.messages.length} messages from session history`);
      try {
        const context = await buildConversationContext({
          session_id,
          user_id,
          query: '',
          system_prompt,
          include_history,
          chatSession
        });
        historyContext = context.historyText || '';
      } catch (error) {
        logger.warn('Failed to build history context, proceeding without it', { error: error.message });
      }
    }
  }
  
  // Create user message
  const userMessage = createMessage('user', query);
  
  try {
    while (iteration < max_iterations) {
      iteration++;
      logger.info(`=== Iteration ${iteration}/${max_iterations} ===`);
      
      // Plan next action (with optional history)
      let nextAction = await planNextAction(
        query,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        historyContext,
        logger
      );
      
      logger.info('Planned action', { 
        action: nextAction.action, 
        reasoning: nextAction.reasoning 
      });
      
      // PRE-EXECUTION DUPLICATE DETECTION
      // Check if this action is a duplicate before executing
      const duplicateCheck = isDuplicateAction(nextAction, executionTrace);
      
      if (duplicateCheck.isDuplicate) {
        logger.warn('Duplicate action detected', {
          action: duplicateCheck.action,
          duplicateIteration: duplicateCheck.duplicateIteration,
          currentIteration: iteration,
          message: duplicateCheck.message
        });
        
        // Emit SSE event for duplicate detection
        if (stream && responseStream) {
          emitSSE(responseStream, 'duplicate_detected', {
            iteration,
            action: duplicateCheck.action,
            duplicateIteration: duplicateCheck.duplicateIteration,
            message: duplicateCheck.message
          });
        }
        
        // If we already have sufficient data, force finalization
        if (hasSufficientData(toolResults)) {
          logger.info('Forcing finalization due to duplicate action with sufficient data');
          
          // Override action to FINALIZE
          nextAction = {
            action: 'FINALIZE',
            reasoning: `Duplicate action detected (already executed in iteration ${duplicateCheck.duplicateIteration}). Finalizing with existing data.`,
            parameters: {}
          };
          
          // Emit SSE event
          if (stream && responseStream) {
            emitSSE(responseStream, 'forced_finalize', {
              reason: 'duplicate_with_data',
              message: 'Preventing duplicate execution - sufficient data already available'
            });
          }
        } else {
          // No sufficient data yet, but still a duplicate
          logger.warn('Duplicate action detected but insufficient data - continuing to let planner adapt');
          
          // Add a warning to trace
          const warningEntry = {
            iteration,
            action: 'DUPLICATE_DETECTED',
            reasoning: duplicateCheck.message,
            parameters: {},
            timestamp: new Date().toISOString(),
            status: 'warning'
          };
          executionTrace.push(warningEntry);
          
          // Continue to next iteration to replan
          continue;
        }
      }
      
      // Add to trace
      const traceEntry = {
        iteration,
        action: nextAction.action,
        reasoning: nextAction.reasoning,
        parameters: nextAction.parameters,
        timestamp: new Date().toISOString()
      };
      executionTrace.push(traceEntry);
      
      // Emit SSE event for tool selection
      if (stream && responseStream) {
        emitSSE(responseStream, 'tool_selected', {
          iteration,
          tool: nextAction.action,
          reasoning: nextAction.reasoning,
          parameters: nextAction.parameters
        });
      }
      
      // Check if we should finalize
      if (nextAction.action === 'FINALIZE') {
        logger.info('Planner decided to finalize');
        finalResponse = await generateFinalResponse(
          query,
          system_prompt,
          executionTrace,
          toolResults,
          model,
          historyContext,
          stream,
          responseStream,
          logger,
          null // No specific tool for FINALIZE action
        );
        break;
      }
      
      // Execute the tool
      try {
        const result = await executeMcpTool(
          nextAction.action,
          nextAction.parameters,
          authToken,
          {
            query,
            model,
            system_prompt,
            session_id,
            user_id,
            responseStream: stream && responseStream ? responseStream : null
          },
          logger
        );

        const { storage: ragStorage, safeResult } = prepareToolResult(
          nextAction.action,
          result,
          mcpConfig.global_settings?.rag_max_docs
        );

        if (ragStorage) {
          collectedRagDocs.push(ragStorage);
        }
        
        // Log what we got from prepareToolResult for debugging
        logger.debug('Tool result prepared', {
          tool: nextAction.action,
          hasRagStorage: !!ragStorage,
          safeResultType: safeResult?.type,
          hasSummary: !!safeResult?.summary,
          summaryPreview: typeof safeResult?.summary === 'string' ? safeResult.summary.substring(0, 100) : null
        });
        
        toolResults[nextAction.action] = safeResult;
        traceEntry.result = safeResult;
        traceEntry.status = 'success';
        
        logger.logToolExecution(
          nextAction.action,
          nextAction.parameters,
          safeResult,
          'success'
        );
        
        logger.logAgentIteration(
          iteration,
          nextAction.action,
          nextAction.reasoning,
          nextAction.parameters,
          safeResult,
          'success'
        );
        
        // Emit SSE event for tool execution result
        if (stream && responseStream) {
          emitSSE(responseStream, 'tool_executed', {
            iteration,
            tool: nextAction.action,
            status: 'success',
            result: safeResult
          });
        }

        // Tools marked as FINALIZE should finalize immediately
        const shouldFinalizeNow = isFinalizeTool(nextAction.action);
        if (shouldFinalizeNow) {
          logger.info('Finalize-category tool executed, finalizing immediately');
          
          // Wrap the raw result in a consistent JSON object structure
          const finalizeResponse = {
            source_tool: nextAction.action,
            content: result
          };
          
          // For non-streaming: keep as object (will be serialized in JSON response)
          // For streaming: will be stringified when emitting
          finalResponse = finalizeResponse;
          finalResponseSourceTool = nextAction.action;
          
          logger.info('Sending finalize tool result as JSON object', {
            tool: nextAction.action,
            resultType: typeof result,
            isString: typeof result === 'string',
            isObject: typeof result === 'object' && result !== null
          });
          
          // If streaming, emit the JSON object as a stringified chunk
          if (stream && responseStream) {
            const finalizeResponseStr = JSON.stringify(finalizeResponse, null, 2);
            emitSSE(responseStream, 'final_response', { 
              chunk: finalizeResponseStr, 
              tool: nextAction.action
            });
          }
          
          break;
        }
      } catch (error) {
        logger.error('Tool execution failed', { 
          tool: nextAction.action, 
          error: error.message,
          stack: error.stack 
        });
        
        logger.logToolExecution(
          nextAction.action,
          nextAction.parameters,
          null,
          'failed',
          error
        );
        
        logger.logAgentIteration(
          iteration,
          nextAction.action,
          nextAction.reasoning,
          nextAction.parameters,
          { error: error.message },
          'failed'
        );
        
        traceEntry.error = error.message;
        traceEntry.status = 'failed';
        toolResults[nextAction.action] = { error: error.message };
        
        // Emit SSE event for tool execution failure
        if (stream && responseStream) {
          emitSSE(responseStream, 'tool_executed', {
            iteration,
            tool: nextAction.action,
            status: 'failed',
            error: error.message
          });
        }
        
        // Try to recover from error
        const shouldContinue = await handleToolError(
          nextAction,
          error,
          executionTrace,
          toolResults,
          logger
        );
        
        if (!shouldContinue) {
          // Generate response with partial results
          finalResponse = await generateFinalResponse(
            query,
            system_prompt,
            executionTrace,
            toolResults,
            model,
            historyContext,
            stream,
            responseStream,
            logger,
            null // Error case, no specific tool
          );
          break;
        }
      }
    }
    
    // Safety net: hit max iterations
    if (!finalResponse) {
      logger.warn('Max iterations reached, finalizing');
      finalResponse = await generateFinalResponse(
        query,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        historyContext,
        stream,
        responseStream,
        logger,
        null // Max iterations, no specific tool
      );
    }
    
    logger.info('Agent loop complete', { 
      iterations: iteration, 
      toolsUsed: Object.keys(toolResults).length 
    });
    
    // Create assistant message with the final response
    const assistantMessage = createMessage('assistant', finalResponse);
    
    // Add tool metadata if the response was generated by a specific tool
    if (finalResponseSourceTool) {
      assistantMessage.source_tool = finalResponseSourceTool;
    }
    
    // Create system message with execution trace (for debugging/transparency)
    let systemMessage = null;
    if (system_prompt || executionTrace.length > 0) {
      const traceDetails = `Agent Execution:\n- Iterations: ${iteration}\n- Tools Used: ${Object.keys(toolResults).length}\n\nExecution Trace:\n${executionTrace.map(t => `[${t.iteration}] ${t.action}: ${t.reasoning}`).join('\n')}`;
      
      const systemContent = system_prompt 
        ? `${system_prompt}\n\n${traceDetails}`
        : traceDetails;
      
      systemMessage = createMessage('system', systemContent);
      
      // Attach full trace to system message for retrieval
      systemMessage.agent_trace = executionTrace;
      systemMessage.tool_results_summary = Object.keys(toolResults);
    }

    // Clone system message for DB vs response to avoid streaming stored docs
    let dbSystemMessage = systemMessage ? JSON.parse(JSON.stringify(systemMessage)) : null;
    let responseSystemMessage = systemMessage ? JSON.parse(JSON.stringify(systemMessage)) : null;

    if (collectedRagDocs.length > 0) {
      if (!dbSystemMessage) {
        dbSystemMessage = createMessage('system', system_prompt || '');
      }
      dbSystemMessage.documents = collectedRagDocs;
    }

    if (responseSystemMessage && responseSystemMessage.documents) {
      delete responseSystemMessage.documents;
    }
    
    // Save conversation to database (for both streaming and non-streaming)
    if (save_chat && session_id) {
      try {
        // Create session if it doesn't exist
        if (!chatSession) {
          await createChatSession(session_id, user_id);
        }
        
        // Save messages
        const messagesToSave = dbSystemMessage 
          ? [userMessage, dbSystemMessage, assistantMessage]
          : [userMessage, assistantMessage];
        
        await addMessagesToSession(session_id, messagesToSave);
        logger.info(`Saved ${messagesToSave.length} messages to session ${session_id}`);
        const messageCount = (chatSession?.messages?.length || 0) + messagesToSave.length;
        maybeQueueSummary({ session_id, user_id, messageCount }).catch((err) => {
          logger.warn('Failed to queue summary', { error: err.message });
        });
      } catch (saveError) {
        logger.error('Failed to save chat', { error: saveError.message, stack: saveError.stack });
        // Don't fail the whole request if save fails
      }
    }
    
    // If streaming, emit completion event and end the stream
    if (stream && responseStream) {
      emitSSE(responseStream, 'done', {
        iterations: iteration,
        tools_used: Object.keys(toolResults).length,
        message_id: assistantMessage.message_id
      });
      responseStream.end();
      // Return minimal metadata for queue service
      return {
        iterations: iteration,
        toolsUsed: Object.keys(toolResults),
        message_id: assistantMessage.message_id
      };
    }
    
    return {
      message: 'success',
      userMessage,
      assistantMessage,
      ...(responseSystemMessage && { systemMessage: responseSystemMessage }),
      agent_metadata: {
        iterations: iteration,
        tools_used: Object.keys(toolResults).length,
        execution_trace: executionTrace
      }
    };
  } catch (error) {
    logger.error('Agent loop failed', { error: error.message, stack: error.stack });
    throw new LLMServiceError('Agent loop failed', error);
  }
}

/**
 * Plan the next action using LLM
 */
async function planNextAction(query, systemPrompt, executionTrace, toolResults, model, historyContext = '', logger = null) {
  try {
    const log = logger || createLogger('Agent-Planner');
    
    // Load available tools
    const toolsDescription = await loadToolsForPrompt();
    
    // Format conversation history if available
    const historyStr = historyContext
      ? `\n\nCONVERSATION HISTORY (for context):\n${historyContext}`
      : '';
    
    // Format execution trace for prompt with duplicate detection
    let traceStr = 'No actions executed yet';
    if (executionTrace.length > 0) {
      const formattedTrace = executionTrace.map(t => ({
        iteration: t.iteration,
        action: t.action,
        reasoning: t.reasoning,
        status: t.status,
        error: t.error,
        parameters: t.parameters // Include parameters for visibility
      }));
      
      traceStr = JSON.stringify(formattedTrace, null, 2);
      
      // Add duplicate warning section if there are duplicates
      const duplicateWarnings = [];
      const actionCounts = {};
      
      for (const trace of executionTrace) {
        if (trace.status === 'success') {
          const key = trace.action;
          actionCounts[key] = (actionCounts[key] || 0) + 1;
        }
      }
      
      for (const [action, count] of Object.entries(actionCounts)) {
        if (count > 1) {
          duplicateWarnings.push(`⚠️  WARNING: "${action}" has been executed ${count} times!`);
        }
      }
      
      if (duplicateWarnings.length > 0) {
        traceStr = `${traceStr}\n\n=== DUPLICATE ACTION WARNINGS ===\n${duplicateWarnings.join('\n')}\n\nDO NOT repeat these actions with the same parameters!`;
      }
    }
    
    // Format tool results for prompt (all results are now file references)
    const resultsStr = Object.keys(toolResults).length > 0
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(toolResults).map(([key, value]) => {
              // Check if this is a file reference (expected for all results)
              if (value && value.type === 'file_reference') {
                return [key, {
                  type: 'FILE_SAVED',
                  fileId: value.fileId,
                  summary: value.summary,
                  message: value.message,
                  note: 'Result saved to file. Use local.get_file_info to see details, then use internal_server file tools to query/extract data.'
                }];
              }
              
              // Fallback for non-file-reference results (should be rare/error cases)
              const resultStr = JSON.stringify(value);
              if (resultStr.length > 2000) {
                return [key, `[Result truncated - ${resultStr.length} chars]`];
              }
              return [key, value];
            })
          ),
          null,
          2
        )
      : 'No tool results yet';
    
    // Build planning prompt
    const planningPrompt = promptManager.formatPrompt(
      promptManager.getAgentPrompt('taskPlanning'),
      {
        tools: toolsDescription,
        executionTrace: traceStr,
        toolResults: resultsStr,
        query: query,
        systemPrompt: (systemPrompt || 'No additional context') + historyStr
      }
    );
    
    // Get model data
    const modelData = await getModelData(model);
    
    // Log the prompt being sent
    log.logPrompt('Task Planning', planningPrompt, model, {
      executionTraceLength: executionTrace.length,
      toolResultsCount: Object.keys(toolResults).length
    });
    
    // Call LLM
    const response = await queryChatOnly({
      query: planningPrompt,
      model,
      system_prompt: 'You are a task planning agent. Always respond with valid JSON.',
      modelData
    });
    
    // Log the response
    log.logResponse('Task Planning', response, model);
    log.debug('Raw LLM planning response', { response });
    
    // Parse JSON response
    const parsed = safeParseJson(response);
    log.debug('Parsed planning JSON', { parsed });
    
    if (!parsed || !parsed.action) {
      log.error('JSON parsing failed or missing action field', { 
        rawResponse: response, 
        parsedResult: parsed 
      });
      throw new Error('Invalid planning response: missing action field');
    }
    
    return {
      action: parsed.action,
      reasoning: parsed.reasoning || 'No reasoning provided',
      parameters: parsed.parameters || {}
    };
  } catch (error) {
    const log = logger || createLogger('Agent-Planner');
    log.error('Planning failed', { error: error.message, stack: error.stack });
    throw new LLMServiceError('Failed to plan next action', error);
  }
}

/**
 * Generate final response to user
 */
async function generateFinalResponse(query, systemPrompt, executionTrace, toolResults, model, historyContext = '', stream = false, responseStream = null, logger = null, sourceTool = null) {
  try {
    const log = logger || createLogger('Agent-FinalResponse');
    
    // Check if this is a direct response (no tools used)
    const isDirectResponse = Object.keys(toolResults).length === 0;
    log.info('Generating final response', { 
      isDirectResponse, 
      toolResultsCount: Object.keys(toolResults).length,
      stream 
    });
    
    // Format conversation history if available
    const historyStr = historyContext
      ? `\n\nConversation history (for context):\n${historyContext}`
      : '';
    
    let promptToUse;
    
    if (isDirectResponse) {
      // Use direct response prompt for conversational queries
      promptToUse = promptManager.formatPrompt(
        promptManager.getAgentPrompt('directResponse'),
        {
          query: query,
          systemPrompt: systemPrompt || 'No additional context',
          historyContext: historyStr
        }
      );
    } else {
      // Tool-based response: format execution trace and results
      const traceStr = executionTrace.map(t => 
        `Iteration ${t.iteration}: ${t.action} - ${t.reasoning} [${t.status || 'pending'}]`
      ).join('\n');
      
      // Format tool results (all results are now file references)
      const resultsStr = Object.entries(toolResults).map(([tool, result]) => {
        // Check if this is a file reference (expected for all results)
        if (result && result.type === 'file_reference') {
          return `${tool}:\n[FILE SAVED - ${result.summary.recordCount} records, ${result.summary.sizeFormatted}]\n` +
                 `Data Type: ${result.summary.dataType}\n` +
                 `Fields: ${result.summary.fields.join(', ')}\n` +
                 `Sample Record: ${JSON.stringify(result.summary.sampleRecord, null, 2)}\n` +
                 `File ID: ${result.fileId}\n` +
                 `Use local.get_file_info to get full details, then use internal_server file tools to query/extract data.\n`;
        }
        
        // Fallback for non-file-reference results (should be rare/error cases)
        const resultStr = JSON.stringify(result, null, 2);
        if (resultStr.length > 3000) {
          return `${tool}:\n[Result - ${resultStr.length} chars]\n${resultStr.substring(0, 3000)}...\n`;
        }
        return `${tool}:\n${resultStr}\n`;
      }).join('\n---\n');
      
      // Build response prompt
      promptToUse = promptManager.formatPrompt(
        promptManager.getAgentPrompt('finalResponse'),
        {
          query: query,
          executionTrace: traceStr,
          toolResults: resultsStr || 'No tool results available',
          systemPrompt: systemPrompt || 'No additional context'
        }
      );
    }
    
    // Get model data
    const modelData = await getModelData(model);
    
    // Log the prompt being sent
    log.logPrompt('Final Response Generation', promptToUse, model, {
      isDirectResponse,
      stream
    });
    
    // If streaming is enabled, stream the response
    if (stream && responseStream) {
      return await streamFinalResponse(promptToUse, model, modelData, responseStream, log, sourceTool);
    }
    
    // Non-streaming: Call LLM to generate final response
    const response = await queryChatOnly({
      query: promptToUse,
      model,
      system_prompt: 'You are a helpful BV-BRC AI assistant.',
      modelData
    });
    
    // Log the response
    log.logResponse('Final Response Generation', response, model);
    
    return response;
  } catch (error) {
    const log = logger || createLogger('Agent-FinalResponse');
    log.error('Response generation failed', { error: error.message, stack: error.stack });
    throw new LLMServiceError('Failed to generate final response', error);
  }
}

/**
 * Stream final response to user via SSE
 */
async function streamFinalResponse(prompt, model, modelData, responseStream, logger = null, sourceTool = null) {
  try {
    const log = logger || createLogger('Agent-StreamResponse');
    const systemPromptText = 'You are a helpful BV-BRC AI assistant.';
    
    log.info('Starting streaming response', { model });
    
    // Handle client-based models (OpenAI)
    if (modelData.queryType === 'client') {
      const client = setupOpenaiClient(modelData.apiKey, modelData.endpoint);
      const stream = await client.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPromptText },
          { role: 'user', content: prompt }
        ],
        stream: true
      });
      
      let fullResponse = '';
      for await (const part of stream) {
        const text = part.choices?.[0]?.delta?.content;
        if (text) {
          fullResponse += text;
          emitSSE(responseStream, 'final_response', { chunk: text, tool: sourceTool || null });
        }
      }
      
      // Log the complete streamed response
      log.logResponse('Streaming Final Response', fullResponse, model);
      
      return fullResponse;
    }
    
    // Handle request-based models
    if (modelData.queryType === 'request') {
      const payload = {
        model: model,
        temperature: 1.0,
        messages: [
          { role: 'system', content: systemPromptText },
          { role: 'user', content: prompt }
        ],
        stream: true
      };
      
      let fullResponse = '';
      const onChunk = (text) => {
        fullResponse += text;
        emitSSE(responseStream, 'final_response', { chunk: text, tool: sourceTool || null });
      };
      
      await postJsonStream(modelData.endpoint, payload, onChunk, modelData.apiKey);
      
      // Log the complete streamed response
      log.logResponse('Streaming Final Response', fullResponse, model);
      
      return fullResponse;
    }
    
    throw new LLMServiceError(`Invalid queryType for streaming: ${modelData.queryType}`);
  } catch (error) {
    const log = logger || createLogger('Agent-StreamResponse');
    log.error('Streaming response generation failed', { error: error.message, stack: error.stack });
    throw new LLMServiceError('Failed to stream final response', error);
  }
}

/**
 * Handle tool execution error
 * Returns true if agent should continue, false if should finalize
 */
async function handleToolError(failedAction, error, executionTrace, toolResults, logger = null) {
  const log = logger || createLogger('Agent-ErrorHandler');
  log.info('Handling tool error', { 
    failedAction: failedAction.action, 
    error: error.message 
  });
  
  // For now, simple logic: continue if we have some results, otherwise stop
  const hasResults = Object.keys(toolResults).length > 0;
  const isCriticalError = error.message.includes('session') || 
                          error.message.includes('authentication') ||
                          error.message.includes('not found');
  
  // If critical error and no results yet, stop
  if (isCriticalError && !hasResults) {
    log.warn('Critical error with no results, stopping');
    return false;
  }
  
  // If we have multiple failures in a row, stop
  const recentFailures = executionTrace
    .slice(-3)
    .filter(t => t.status === 'failed').length;
  
  if (recentFailures >= 2) {
    log.warn('Multiple consecutive failures, stopping', { recentFailures });
    return false;
  }
  
  // Otherwise, continue and let planner try alternative approach
  log.info('Continuing after error, planner will adapt');
  return true;
}

module.exports = {
  executeAgentLoop,
  planNextAction,
  generateFinalResponse
};

