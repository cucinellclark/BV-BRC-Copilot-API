// services/agentOrchestrator.js

const { v4: uuidv4 } = require('uuid');
const { executeMcpTool } = require('./mcp/mcpExecutor');
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

/**
 * Helper function to emit SSE events
 */
function emitSSE(responseStream, eventType, data) {
  if (!responseStream) return;
  
  try {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    responseStream.write(`event: ${eventType}\ndata: ${dataStr}\n\n`);
  } catch (error) {
    console.error('[Agent] Failed to emit SSE event:', error);
  }
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
  
  console.log('[Agent] Starting agent loop for query:', query);
  
  const executionTrace = [];
  const toolResults = {};
  let iteration = 0;
  let finalResponse = null;
  
  // Get auth token (from opts or config)
  const authToken = auth_token || mcpConfig.auth_token;
  
  // Get or create chat session
  let chatSession = null;
  let history = [];
  if (session_id) {
    chatSession = await getChatSession(session_id);
    if (include_history && chatSession?.messages) {
      history = chatSession.messages;
      console.log(`[Agent] Loaded ${history.length} messages from session history`);
    }
  }
  
  // Create user message
  const userMessage = createMessage('user', query);
  
  try {
    while (iteration < max_iterations) {
      iteration++;
      console.log(`[Agent] Iteration ${iteration}/${max_iterations}`);
      
      // Plan next action (with optional history)
      const nextAction = await planNextAction(
        query,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        history
      );
      
      console.log(`[Agent] Planned action:`, nextAction.action);
      console.log(`[Agent] Reasoning:`, nextAction.reasoning);
      
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
        console.log('[Agent] Planner decided to finalize');
        finalResponse = await generateFinalResponse(
          query,
          system_prompt,
          executionTrace,
          toolResults,
          model,
          history,
          stream,
          responseStream
        );
        break;
      }
      
      // Check if this is a workflow creation request (terminal action)
      if (nextAction.action === 'local.create_workflow') {
        console.log('[Agent] Creating workflow plan (terminal action)');
        
        try {
          const workflowPlan = await executeMcpTool(
            nextAction.action,
            nextAction.parameters,
            authToken,
            {
              query,
              model,
              system_prompt
            }
          );
          
          console.log('[Agent] Workflow plan received:', JSON.stringify(workflowPlan, null, 2));
          
          traceEntry.result = workflowPlan;
          traceEntry.status = 'success';
          toolResults[nextAction.action] = workflowPlan;
          
          // Emit SSE event for workflow creation
          if (stream && responseStream) {
            emitSSE(responseStream, 'workflow_created', {
              workflow: workflowPlan
            });
          }
          
          // Format workflow as final response
          finalResponse = await formatWorkflowResponse(workflowPlan, query);
          
          console.log('[Agent] Workflow plan created, ending agent loop');
          break;
        } catch (error) {
          console.error('[Agent] Workflow creation failed:', error);
          traceEntry.error = error.message;
          traceEntry.status = 'failed';
          toolResults[nextAction.action] = { error: error.message };
          
          // Generate error response
          finalResponse = `I apologize, but I encountered an error while creating the workflow plan: ${error.message}`;
          break;
        }
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
            system_prompt
          }
        );
        
        toolResults[nextAction.action] = result;
        traceEntry.result = result;
        traceEntry.status = 'success';
        
        console.log(`[Agent] Tool executed successfully`);
        console.log(`[Agent] Result received:`, JSON.stringify(result, null, 2));
        
        // Emit SSE event for tool execution result
        if (stream && responseStream) {
          emitSSE(responseStream, 'tool_executed', {
            iteration,
            tool: nextAction.action,
            status: 'success',
            result: result
          });
        }
      } catch (error) {
        console.error(`[Agent] Tool execution failed:`, error.message);
        
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
          toolResults
        );
        
        if (!shouldContinue) {
          // Generate response with partial results
          finalResponse = await generateFinalResponse(
            query,
            system_prompt,
            executionTrace,
            toolResults,
            model,
            history,
            stream,
            responseStream
          );
          break;
        }
      }
    }
    
    // Safety net: hit max iterations
    if (!finalResponse) {
      console.log('[Agent] Max iterations reached, finalizing');
      finalResponse = await generateFinalResponse(
        query,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        history,
        stream,
        responseStream
      );
    }
    
    console.log('[Agent] Agent loop complete');
    
    // Create assistant message with the final response
    const assistantMessage = createMessage('assistant', finalResponse);
    
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
    
    // Save conversation to database (for both streaming and non-streaming)
    if (save_chat && session_id) {
      try {
        // Create session if it doesn't exist
        if (!chatSession) {
          await createChatSession(session_id, user_id);
        }
        
        // Save messages
        const messagesToSave = systemMessage 
          ? [userMessage, systemMessage, assistantMessage]
          : [userMessage, assistantMessage];
        
        await addMessagesToSession(session_id, messagesToSave);
        console.log(`[Agent] Saved ${messagesToSave.length} messages to session ${session_id}`);
      } catch (saveError) {
        console.error('[Agent] Failed to save chat:', saveError);
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
      return; // Don't return response object in streaming mode
    }
    
    return {
      message: 'success',
      userMessage,
      assistantMessage,
      ...(systemMessage && { systemMessage }),
      agent_metadata: {
        iterations: iteration,
        tools_used: Object.keys(toolResults).length,
        execution_trace: executionTrace
      }
    };
  } catch (error) {
    console.error('[Agent] Agent loop failed:', error);
    throw new LLMServiceError('Agent loop failed', error);
  }
}

/**
 * Plan the next action using LLM
 */
async function planNextAction(query, systemPrompt, executionTrace, toolResults, model, history = []) {
  try {
    // Load available tools
    const toolsDescription = await loadToolsForPrompt();
    
    // Format conversation history if available
    const historyStr = history.length > 0
      ? `\n\nCONVERSATION HISTORY (for context):\n${history.slice(-5).map(m => `${m.role}: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`).join('\n')}`
      : '';
    
    // Format execution trace for prompt
    const traceStr = executionTrace.length > 0
      ? JSON.stringify(executionTrace.map(t => ({
          iteration: t.iteration,
          action: t.action,
          reasoning: t.reasoning,
          status: t.status,
          error: t.error
        })), null, 2)
      : 'No actions executed yet';
    
    // Format tool results for prompt (truncate large results)
    const resultsStr = Object.keys(toolResults).length > 0
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(toolResults).map(([key, value]) => {
              // Truncate large results
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
    
    // Call LLM
    const response = await queryChatOnly({
      query: planningPrompt,
      model,
      system_prompt: 'You are a task planning agent. Always respond with valid JSON.',
      modelData
    });
    
    console.log('[Agent] Raw LLM response:', response);
    
    // Parse JSON response
    const parsed = safeParseJson(response);
    console.log('[Agent] Parsed JSON:', parsed);
    
    if (!parsed || !parsed.action) {
      console.error('[Agent] JSON parsing failed or missing action field');
      console.error('[Agent] Raw response was:', response);
      console.error('[Agent] Parsed result was:', parsed);
      throw new Error('Invalid planning response: missing action field');
    }
    
    return {
      action: parsed.action,
      reasoning: parsed.reasoning || 'No reasoning provided',
      parameters: parsed.parameters || {}
    };
  } catch (error) {
    console.error('[Agent] Planning failed:', error);
    throw new LLMServiceError('Failed to plan next action', error);
  }
}

/**
 * Generate final response to user
 */
async function generateFinalResponse(query, systemPrompt, executionTrace, toolResults, model, history = [], stream = false, responseStream = null) {
  try {
    // Check if this is a direct response (no tools used)
    const isDirectResponse = Object.keys(toolResults).length === 0;
    
    // Format conversation history if available
    const historyStr = history.length > 0
      ? `\n\nConversation history (for context):\n${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n\n')}`
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
      
      // Format tool results (with truncation for large results)
      const resultsStr = Object.entries(toolResults).map(([tool, result]) => {
        const resultStr = JSON.stringify(result, null, 2);
        if (resultStr.length > 3000) {
          return `${tool}:\n[Large result - ${resultStr.length} chars]\n${resultStr.substring(0, 3000)}...\n`;
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
    
    // If streaming is enabled, stream the response
    if (stream && responseStream) {
      return await streamFinalResponse(promptToUse, model, modelData, responseStream);
    }
    
    // Non-streaming: Call LLM to generate final response
    const response = await queryChatOnly({
      query: promptToUse,
      model,
      system_prompt: 'You are a helpful BV-BRC AI assistant.',
      modelData
    });
    
    return response;
  } catch (error) {
    console.error('[Agent] Response generation failed:', error);
    throw new LLMServiceError('Failed to generate final response', error);
  }
}

/**
 * Stream final response to user via SSE
 */
async function streamFinalResponse(prompt, model, modelData, responseStream) {
  try {
    const systemPromptText = 'You are a helpful BV-BRC AI assistant.';
    
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
          emitSSE(responseStream, 'final_response', { chunk: text });
        }
      }
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
        emitSSE(responseStream, 'final_response', { chunk: text });
      };
      
      await postJsonStream(modelData.endpoint, payload, onChunk, modelData.apiKey);
      return fullResponse;
    }
    
    throw new LLMServiceError(`Invalid queryType for streaming: ${modelData.queryType}`);
  } catch (error) {
    console.error('[Agent] Streaming response generation failed:', error);
    throw new LLMServiceError('Failed to stream final response', error);
  }
}

/**
 * Handle tool execution error
 * Returns true if agent should continue, false if should finalize
 */
async function handleToolError(failedAction, error, executionTrace, toolResults) {
  console.log('[Agent] Handling tool error...');
  
  // For now, simple logic: continue if we have some results, otherwise stop
  const hasResults = Object.keys(toolResults).length > 0;
  const isCriticalError = error.message.includes('session') || 
                          error.message.includes('authentication') ||
                          error.message.includes('not found');
  
  // If critical error and no results yet, stop
  if (isCriticalError && !hasResults) {
    console.log('[Agent] Critical error with no results, stopping');
    return false;
  }
  
  // If we have multiple failures in a row, stop
  const recentFailures = executionTrace
    .slice(-3)
    .filter(t => t.status === 'failed').length;
  
  if (recentFailures >= 2) {
    console.log('[Agent] Multiple consecutive failures, stopping');
    return false;
  }
  
  // Otherwise, continue and let planner try alternative approach
  console.log('[Agent] Continuing after error, planner will adapt');
  return true;
}

/**
 * Format workflow plan as a readable response
 */
async function formatWorkflowResponse(workflowPlan, originalQuery) {
  // Create a nicely formatted text representation of the workflow
  let response = `# Workflow Plan: ${workflowPlan.workflow_title || 'Multi-Step Analysis'}\n\n`;
  
  if (workflowPlan.description) {
    response += `${workflowPlan.description}\n\n`;
  }
  
  response += `**Query:** ${originalQuery}\n\n`;
  
  if (workflowPlan.estimated_duration || workflowPlan.estimated_steps) {
    response += `**Estimated Steps:** ${workflowPlan.estimated_steps || workflowPlan.steps?.length || 'N/A'}\n`;
    if (workflowPlan.estimated_duration) {
      response += `**Estimated Duration:** ${workflowPlan.estimated_duration}\n`;
    }
    response += '\n';
  }
  
  response += `## Execution Steps\n\n`;
  
  if (workflowPlan.steps && Array.isArray(workflowPlan.steps)) {
    workflowPlan.steps.forEach((step) => {
      response += `### Step ${step.step || step.step_number}\n`;
      response += `**Action:** \`${step.action}\`\n\n`;
      
      if (step.description) {
        response += `**Description:** ${step.description}\n\n`;
      }
      
      if (step.reason || step.reasoning) {
        response += `**Reasoning:** ${step.reason || step.reasoning}\n\n`;
      }
      
      if (step.parameters && Object.keys(step.parameters).length > 0) {
        response += `**Parameters:**\n\`\`\`json\n${JSON.stringify(step.parameters, null, 2)}\n\`\`\`\n\n`;
      }
      
      if (step.expected_output) {
        response += `**Expected Output:** ${step.expected_output}\n\n`;
      }
      
      response += '---\n\n';
    });
  }
  
  if (workflowPlan.final_deliverable) {
    response += `## Final Deliverable\n\n${workflowPlan.final_deliverable}\n`;
  }
  
  return response;
}

module.exports = {
  executeAgentLoop,
  planNextAction,
  generateFinalResponse,
  formatWorkflowResponse
};

