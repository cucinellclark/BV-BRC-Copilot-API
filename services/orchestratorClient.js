// services/orchestratorClient.js
//
// Thin client that calls the Python multi-agent orchestrator on holly and
// maps its SSE event stream back to the gateway's existing SSE protocol
// so the UI doesn't need to change.
//
// The orchestrator (FastAPI on holly) exposes:
//   POST /orchestrate/stream  — SSE event stream
//   POST /orchestrate         — batch (non-streaming) response
//   GET  /health              — health check
//
// This module is called by the new executeOrchestratorLoop() entry point
// in agentOrchestrator.js, which the queue worker uses instead of the
// legacy executeAgentLoop() when config.orchestrator.enabled is true.

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config.json');
const { createLogger } = require('./logger');
const { emitSSE } = require('./sseUtils');
const {
  getChatSession,
  createChatSession,
  addMessagesToSession,
  addWorkflowIdToSession,
  getModelData
} = require('./dbUtils');
const { buildConversationContext, buildWorkflowAwareHistory } = require('./memory/conversationContextService');
const { registerWorkflowWatch } = require('./workflowMonitorService');
const { getSessionMemory } = require('./memory/sessionMemoryService');
const { maybeQueueSummary } = require('./summaryQueueService');

const logger = createLogger('OrchestratorClient');

const ORCHESTRATOR_URL = config.orchestrator?.url || 'http://140.221.78.15:9000';
const STREAM_ENDPOINT = config.orchestrator?.stream_endpoint || '/orchestrate/stream';
const BATCH_ENDPOINT = config.orchestrator?.batch_endpoint || '/orchestrate';
const HEALTH_ENDPOINT = config.orchestrator?.health_endpoint || '/health';
const TIMEOUT_MS = config.orchestrator?.timeout_ms || 600000;

// ---------------------------------------------------------------------------
// Helpers for tool-name qualification and call-envelope construction
// ---------------------------------------------------------------------------

/**
 * Qualify a bare tool name with the MCP server prefix.
 *
 * The sub-agents' tool_trace contains bare LLM-level function names
 * (e.g., "bvbrc_search_data"). The frontend expects MCP-qualified names
 * (e.g., "bvbrc_server.bvbrc_search_data") OR at minimum names that
 * pass indexOf() checks (e.g., containing "bvbrc_search_data").
 *
 * The server prefix (e.g., "bvbrc_server") comes from the agent's
 * mcp_server_name config field, propagated through event data.
 * This avoids hardcoding any server name in the gateway.
 *
 * @param {string} bareName - The bare tool name from tool_trace
 * @param {string|null} mcpServerName - The MCP server prefix from event data
 * @returns {string|null} The qualified tool name, or null if bareName is falsy
 */
function _qualifyToolName(bareName, mcpServerName) {
  if (!bareName) return null;
  // If already qualified (contains a dot), return as-is
  if (bareName.includes('.')) return bareName;
  // If we have a server name from the agent config, use it
  if (mcpServerName) return `${mcpServerName}.${bareName}`;
  // Fallback: return bare name (frontend indexOf matching may still work)
  return bareName;
}

/**
 * Extract the workspace home path from a BV-BRC auth token.
 *
 * The token contains ``un=<user>`` (e.g. ``un=alice@bvbrc``).
 * The workspace home path is ``/<user>/home``.
 *
 * @param {string} authToken - Raw BV-BRC auth token string
 * @returns {string|null} Workspace home path, or null if user not found
 */
function _workspacePathFromToken(authToken) {
  if (!authToken) return null;
  const match = authToken.match(/(?:^|[|&])un=([^|&]+)/);
  if (!match) return null;
  const user = match[1].trim();
  return user ? `/${user}/home` : null;
}

/**
 * Build a tool call envelope from agent result_for_ui data.
 *
 * The frontend expects a `call` object on final_response with:
 *   { tool, arguments_executed, replayable, replay, rql_replay }
 *
 * The orchestrator's result_for_ui contains the raw agent result,
 * which may have tool_trace entries with arguments. We construct
 * a compatible envelope from whatever is available.
 */
function _buildCallEnvelope(toolName, resultForUi) {
  if (!resultForUi) return null;

  const envelope = {
    tool: toolName || null,
    replayable: false,
  };

  // Extract arguments from the last *successful* tool_trace entry
  // (mirrors the error-skipping logic used in lastToolName extraction)
  if (Array.isArray(resultForUi.tool_trace) && resultForUi.tool_trace.length > 0) {
    let lastExec = null;
    for (let i = resultForUi.tool_trace.length - 1; i >= 0; i--) {
      if (!resultForUi.tool_trace[i].error) {
        lastExec = resultForUi.tool_trace[i];
        break;
      }
    }
    // Fallback to last entry if all had errors
    if (!lastExec) {
      lastExec = resultForUi.tool_trace[resultForUi.tool_trace.length - 1];
    }
    envelope.arguments_executed = lastExec.arguments || {};
  }

  // For query collection results: look for rql_replay / queryUrl
  // These may be in the result_for_ui directly if the agent returned them
  if (resultForUi.rqlQueryUrl || resultForUi.rql_query_url || resultForUi.queryUrl) {
    envelope.replayable = true;
    envelope.rql_replay = {
      data_api_url: resultForUi.rqlQueryUrl || resultForUi.rql_query_url || resultForUi.queryUrl || null,
    };
  }

  // For workspace results: include the result data
  if (resultForUi.items || resultForUi.ui_grids) {
    envelope.result = resultForUi;
  }

  // For workflow results: include the manifest
  if (resultForUi.manifest) {
    envelope.result = resultForUi.manifest;
  }

  return envelope;
}

// ---------------------------------------------------------------------------
// Event mapping: orchestrator event types → gateway SSE event types
// ---------------------------------------------------------------------------
//
// The Python orchestrator emits these EventType values:
//   orchestrator_start, orchestrator_done, orchestrator_error
//   routing_start, routing_decision
//   agent_start, agent_progress, agent_tool_call, agent_tool_result, agent_result, agent_error
//   synthesis_start, synthesis_chunk, synthesis_done
//   needs_input
//
// The existing UI expects these SSE events:
//   queued, started, progress, tool_selected, tool_executed,
//   session_file_created, image_context, duplicate_detected,
//   forced_finalize, tool_blocked, final_response, done, error, cancelled
//

/**
 * Map an orchestrator SSE event to zero or more gateway SSE events.
 *
 * @param {string} eventType - Orchestrator event type (e.g. "routing_decision")
 * @param {object} eventData - Parsed event payload
 * @param {object} responseStream - The gateway SSE response stream
 * @param {object} state - Mutable state accumulator for the request
 */
function mapOrchestratorEvent(eventType, eventData, responseStream, state) {
  switch (eventType) {
    // -- Lifecycle --
    case 'orchestrator_start':
      // Nothing to emit; the gateway already sent 'started' via queue
      break;

    case 'orchestrator_done':
      state.responseText = eventData.response_text || '';
      state.agentsUsed = eventData.agents_used || [];
      state.toolCalls = eventData.tool_calls || [];
      state.resultForUi = eventData.result_for_ui || {};
      state.decision = eventData.decision || 'agent';
      state.elapsedMs = eventData.elapsed_ms || 0;
      // Don't emit 'done' here — we do that after persisting messages
      break;

    case 'orchestrator_error':
      emitSSE(responseStream, 'error', {
        error: eventData.error || 'Unknown orchestrator error',
        timestamp: new Date().toISOString()
      });
      break;

    // -- Routing --
    case 'routing_start':
      // Could emit a "thinking" event in the future; skip for now
      break;

    case 'routing_decision':
      emitSSE(responseStream, 'tool_selected', {
        action: eventData.agent_key || eventData.decision || 'orchestrator',
        reasoning: eventData.reasoning || '',
        agent: eventData.agent_key || null,
        decision_type: eventData.decision,
        timestamp: new Date().toISOString()
      });
      break;

    // -- Agent execution --
    case 'agent_start':
      emitSSE(responseStream, 'tool_selected', {
        action: `${eventData.agent || 'agent'}_chat`,
        reasoning: `Routing to ${eventData.agent || 'agent'}: ${eventData.task || ''}`,
        agent: eventData.agent || null,
        timestamp: new Date().toISOString()
      });
      break;

    case 'agent_progress':
      emitSSE(responseStream, 'progress', {
        agent: eventData.agent || null,
        message: eventData.message || '',
        progress: eventData.progress != null ? eventData.progress : 0,
        total: eventData.total != null ? eventData.total : null,
        timestamp: new Date().toISOString()
      });
      break;

    case 'agent_tool_call':
      emitSSE(responseStream, 'tool_selected', {
        tool: _qualifyToolName(eventData.tool || eventData.name, eventData.mcp_server_name || state.mcpServerName),
        action: _qualifyToolName(eventData.tool || eventData.name, eventData.mcp_server_name || state.mcpServerName),
        reasoning: eventData.reasoning || '',
        parameters: eventData.arguments || eventData.parameters || {},
        agent: eventData.agent || null,
        timestamp: new Date().toISOString()
      });
      break;

    case 'agent_tool_result':
      emitSSE(responseStream, 'tool_executed', {
        tool: _qualifyToolName(eventData.tool || eventData.name, eventData.mcp_server_name || state.mcpServerName),
        action: _qualifyToolName(eventData.tool || eventData.name, eventData.mcp_server_name || state.mcpServerName),
        success: eventData.success !== false,
        status: eventData.success !== false ? 'success' : 'error',
        result: eventData.result || null,
        result_summary: eventData.summary || eventData.result_summary || '',
        call: eventData.call || null,
        agent: eventData.agent || null,
        timestamp: new Date().toISOString()
      });
      break;

    case 'agent_result': {
      state.lastAgentResult = eventData;
      // Store the full result_for_ui for later inclusion in final_response
      if (eventData.result_for_ui) {
        state.lastResultForUi = eventData.result_for_ui;
      }
      // Capture whether the workflow was auto-submitted by the service agent
      const autoSubmitted = !!(eventData.result_for_ui?.auto_submitted
                            || eventData.auto_submitted);
      state.autoSubmitted = autoSubmitted;
      // Capture the MCP server prefix from the agent's config (propagated via event data)
      const mcpServerName = eventData.result_for_ui?.mcp_server_name
                         || eventData.mcp_server_name
                         || null;
      state.mcpServerName = mcpServerName;
      // Extract the actual MCP tool name from tool_trace for UI rendering
      if (eventData.result_for_ui && Array.isArray(eventData.result_for_ui.tool_trace)) {
        const trace = eventData.result_for_ui.tool_trace;
        for (let i = trace.length - 1; i >= 0; i--) {
          if (trace[i].tool && !trace[i].error) {
            state.lastToolName = _qualifyToolName(trace[i].tool, mcpServerName);
            break;
          }
        }
        // Fallback: use first tool if all had errors
        if (!state.lastToolName && trace.length > 0 && trace[0].tool) {
          state.lastToolName = _qualifyToolName(trace[0].tool, mcpServerName);
        }
      }
      // When the agent result contains a workflow manifest (from Service2's
      // 3-phase pipeline), override the tool name so the frontend recognises
      // this as a workflow result and renders the appropriate card.
      // Use 'submit_workflow' when auto-submitted, 'plan_workflow' otherwise.
      const rui = eventData.result_for_ui || {};
      if (rui.manifest && rui.workflow_id) {
        const workflowToolName = autoSubmitted ? 'submit_workflow' : 'plan_workflow';
        state.lastToolName = _qualifyToolName(workflowToolName, mcpServerName);
      }
      emitSSE(responseStream, 'tool_executed', {
        action: `${eventData.agent || 'agent'}_chat`,
        success: eventData.status !== 'error',
        result_summary: typeof eventData.result_for_llm === 'string'
          ? eventData.result_for_llm.substring(0, 200)
          : '',
        agent: eventData.agent || null,
        timestamp: new Date().toISOString()
      });
      break;
    }

    case 'agent_error':
      emitSSE(responseStream, 'error', {
        error: eventData.error || 'Agent execution failed',
        agent: eventData.agent || null,
        timestamp: new Date().toISOString()
      });
      break;

    // -- Synthesis --
    case 'synthesis_start':
      // Nothing to emit; the UI just waits for final_response chunks
      break;

    case 'synthesis_chunk': {
      const payload = {
        chunk: eventData.chunk || eventData.text || '',
        tool: state.lastToolName || state.agentsUsed?.[0] || null,
      };
      // Attach structured result data on the first chunk only
      if (!state.sentResultForUi && state.lastResultForUi) {
        payload.call = _buildCallEnvelope(state.lastToolName, state.lastResultForUi);
        state.sentResultForUi = true;
      }
      emitSSE(responseStream, 'final_response', payload);
      state.streamedResponse = (state.streamedResponse || '') + (eventData.chunk || eventData.text || '');
      break;
    }

    case 'synthesis_done':
      // The full response text is captured in orchestrator_done
      if (eventData.response_text) {
        state.responseText = eventData.response_text;
      }
      break;

    // -- Agent interaction --
    case 'needs_input':
      emitSSE(responseStream, 'needs_input', {
        message: eventData.message || eventData.question || '',
        agent: eventData.agent || null,
        options: eventData.options || null,
        timestamp: new Date().toISOString()
      });
      break;

    // -- Planning agent events --
    case 'ask_questions':
      emitSSE(responseStream, 'ask_questions', {
        questions: eventData.questions || [],
        agent: eventData.agent || 'planning',
        timestamp: new Date().toISOString()
      });
      break;

    case 'plan_created':
      emitSSE(responseStream, 'plan_created', {
        plan: eventData.plan || {},
        agent: eventData.agent || 'planning',
        timestamp: new Date().toISOString()
      });
      // Store plan on state for message persistence
      state.plan = eventData.plan || null;
      break;

    case 'plan_step_started':
      emitSSE(responseStream, 'plan_step_started', {
        plan_id: eventData.plan_id,
        step_id: eventData.step_id,
        step_index: eventData.step_index,
        agent: eventData.agent,
        timestamp: new Date().toISOString()
      });
      break;

    case 'plan_step_completed':
      emitSSE(responseStream, 'plan_step_completed', {
        plan_id: eventData.plan_id,
        step_id: eventData.step_id,
        step_index: eventData.step_index,
        result_summary: eventData.result_summary,
        agent_result: eventData.agent_result,
        structured_data: eventData.structured_data || null,
        timestamp: new Date().toISOString()
      });
      break;

    case 'plan_step_failed':
      emitSSE(responseStream, 'plan_step_failed', {
        plan_id: eventData.plan_id,
        step_id: eventData.step_id,
        step_index: eventData.step_index,
        error: eventData.error,
        timestamp: new Date().toISOString()
      });
      break;

    case 'plan_review_ready':
      emitSSE(responseStream, 'plan_review_ready', {
        plan_id: eventData.plan_id,
        step_id: eventData.step_id,
        step_index: eventData.step_index,
        review_config: eventData.review_config || {},
        source_data: eventData.source_data || {},
        prompt: eventData.prompt || 'Review the results before continuing.',
        timestamp: new Date().toISOString()
      });
      break;

    case 'plan_workflow_submitted':
      emitSSE(responseStream, 'plan_workflow_submitted', {
        plan_id: eventData.plan_id,
        step_id: eventData.step_id,
        step_index: eventData.step_index,
        workflow_id: eventData.workflow_id,
        submission_id: eventData.submission_id,
        submission_ids: eventData.submission_ids || [],
        result_summary: eventData.result_summary || '',
        timestamp: new Date().toISOString()
      });
      break;

    default:
      // Unknown event type — log but don't crash
      logger.debug('Unhandled orchestrator event type', { eventType, eventData });
      break;
  }
}


// ---------------------------------------------------------------------------
// SSE stream consumer — connects to the Python orchestrator's /orchestrate/stream
// ---------------------------------------------------------------------------

/**
 * Call the orchestrator's streaming endpoint and relay events to the gateway SSE stream.
 *
 * @param {object} orchestratorRequest - OrchestratorRequest payload
 * @param {object} responseStream - The gateway SSE response stream (res object)
 * @param {function} shouldCancel - Returns true if the job has been cancelled
 * @returns {object} State object with accumulated results
 */
async function streamFromOrchestrator(orchestratorRequest, responseStream, shouldCancel) {
  const url = `${ORCHESTRATOR_URL}${STREAM_ENDPOINT}`;
  const state = {
    responseText: '',
    streamedResponse: '',
    agentsUsed: [],
    toolCalls: [],
    resultForUi: {},
    decision: null,
    elapsedMs: 0,
    lastAgentResult: null,
    lastToolName: null,
    mcpServerName: null,
    lastResultForUi: null,
    sentResultForUi: false,
    autoSubmitted: false,
    error: null,
    plan: null
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) {
        state.error = err.message || String(err);
        reject(err);
      } else {
        resolve(state);
      }
    }

    // Use axios to POST with responseType stream, then parse SSE manually
    const controller = new AbortController();

    // Cancellation polling
    const cancelInterval = setInterval(() => {
      if (shouldCancel && shouldCancel()) {
        controller.abort();
        clearInterval(cancelInterval);
        const cancelErr = new Error('Job cancelled by user');
        cancelErr.isCancelled = true;
        finish(cancelErr);
      }
    }, 1000);

    axios.post(url, orchestratorRequest, {
      responseType: 'stream',
      signal: controller.signal,
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...(orchestratorRequest.auth_token
          ? { 'Authorization': `Bearer ${orchestratorRequest.auth_token}` }
          : {})
      }
    }).then((response) => {
      const stream = response.data;
      let buffer = '';

      stream.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        logger.info('Raw SSE chunk received', {
          length: chunkStr.length,
          preview: chunkStr.substring(0, 300).replace(/\n/g, '\\n')
        });
        buffer += chunkStr;

        // Normalize \r\n to \n so the frame delimiter is always \n\n
        buffer = buffer.replace(/\r\n/g, '\n');

        // Parse SSE frames: each frame is "event: <type>\ndata: <json>\n\n"
        const frames = buffer.split('\n\n');
        buffer = frames.pop(); // Keep incomplete last frame in buffer

        logger.debug('SSE frame split', {
          frameCount: frames.length,
          bufferRemainder: buffer.length
        });

        for (const frame of frames) {
          if (!frame.trim()) continue;

          const lines = frame.split('\n');
          let eventType = null;
          let eventDataStr = null;

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              eventDataStr = line.slice(5).trim();
            } else if (line.startsWith(':')) {
              // Comment / keep-alive — ignore
            }
          }

          if (eventType && eventDataStr) {
            try {
              const parsed = JSON.parse(eventDataStr);
              const eventData = parsed.data || parsed;
              const actualType = parsed.type || eventType;
              logger.info('Orchestrator SSE event received', {
                eventType,
                actualType,
                dataPreview: eventDataStr.substring(0, 300)
              });
              mapOrchestratorEvent(actualType, eventData, responseStream, state);

              // Check for terminal event
              if (actualType === 'orchestrator_done') {
                clearInterval(cancelInterval);
                finish(null);
              }
            } catch (parseErr) {
              logger.warn('Failed to parse orchestrator SSE event', {
                eventType,
                rawData: eventDataStr.substring(0, 200),
                error: parseErr.message
              });
            }
          }
        }
      });

      stream.on('end', () => {
        logger.info('Orchestrator SSE stream ended', {
          bufferRemainder: buffer.length,
          bufferPreview: buffer.substring(0, 200).replace(/\n/g, '\\n'),
          stateResponseText: (state.responseText || '').substring(0, 100),
          stateDecision: state.decision
        });
        clearInterval(cancelInterval);
        finish(null);
      });

      stream.on('error', (err) => {
        clearInterval(cancelInterval);
        logger.error('Orchestrator SSE stream error', { error: err.message });
        finish(err);
      });

    }).catch((err) => {
      clearInterval(cancelInterval);
      if (err.isCancelled) {
        finish(err);
      } else {
        logger.error('Failed to connect to orchestrator', {
          url,
          error: err.message,
          code: err.code
        });
        finish(new Error(`Orchestrator connection failed: ${err.message}`));
      }
    });
  });
}


// ---------------------------------------------------------------------------
// Main entry point — replaces executeAgentLoop when orchestrator is enabled
// ---------------------------------------------------------------------------

/**
 * Execute via the Python orchestrator.
 *
 * This function matches the signature and return contract of executeAgentLoop()
 * so the queue worker can call it as a drop-in replacement.
 *
 * @param {object} opts - Same opts as executeAgentLoop
 * @returns {object} Result compatible with queue worker expectations
 */
async function executeOrchestratorLoop(opts) {
  const {
    query,
    model,
    session_id,
    job_id = null,
    user_id,
    system_prompt = '',
    save_chat = true,
    include_history = true,
    auth_token = null,
    workspace_items = null,
    selected_jobs = null,
    selected_workflows = null,
    images = null,
    files = null,
    auto_submit_preference = null,
    target_agent = null,
    workflow_context = null,
    stream = false,
    responseStream = null,
    progressCallback = null,
    shouldCancel = () => false
  } = opts;

  const sessionLogger = createLogger('OrchestratorLoop', session_id);
  sessionLogger.info('Starting orchestrator loop', {
    query: query.substring(0, 100),
    session_id,
    user_id,
    model,
    has_workspace_items: !!workspace_items,
    has_images: !!(images && images.length),
    has_files: !!(files && files.length),
    files_count: files ? files.length : 0
  });

  // ------------------------------------------------------------------
  // 1. Build conversation context (same as legacy path)
  // ------------------------------------------------------------------
  let chatSession = null;
  let conversationSummary = '';
  let recentMessages = [];
  let sessionMemory = null;

  if (session_id) {
    chatSession = await getChatSession(session_id);
    if (!chatSession) {
      try {
        await createChatSession(session_id, user_id);
        chatSession = await getChatSession(session_id);
      } catch (err) {
        sessionLogger.warn('Failed to create chat session', { error: err.message });
      }
    }

    // Build history context for the orchestrator
    if (include_history && chatSession?.messages) {
      try {
        const context = await buildConversationContext({
          session_id,
          user_id,
          query: '',
          system_prompt,
          include_history,
          chatSession
        });
        conversationSummary = context.summaryText || '';
        // Extract recent messages for the orchestrator
        if (context.recentMessages && Array.isArray(context.recentMessages)) {
          recentMessages = context.recentMessages;
        } else if (chatSession.messages) {
          // Fallback: grab last 10 messages
          recentMessages = chatSession.messages.slice(-10).map(m => ({
            role: m.role || 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          }));
        }

        // Build workflow-aware history with live status from the engine.
        // This replaces the plain summary with one that includes inline
        // workflow metadata so the LLM can see planned/running workflows.
        try {
          const workflowAwareHistory = await buildWorkflowAwareHistory(
            chatSession.messages
          );
          if (workflowAwareHistory) {
            conversationSummary = workflowAwareHistory;
          }
        } catch (wfErr) {
          sessionLogger.warn('Failed to build workflow-aware history, using plain context', {
            error: wfErr.message
          });
        }
      } catch (err) {
        sessionLogger.warn('Failed to build conversation context', { error: err.message });
      }
    }

    // Load session memory
    try {
      sessionMemory = await getSessionMemory(session_id, user_id);
    } catch (err) {
      sessionLogger.warn('Failed to load session memory', { error: err.message });
    }
  }

  // ------------------------------------------------------------------
  // 2. Persist user message to DB early (matches legacy behavior)
  // ------------------------------------------------------------------
  const userMessage = {
    message_id: uuidv4(),
    role: 'user',
    content: query,
    timestamp: new Date().toISOString()
  };

  // If this request is answering planning clarification questions, persist it
  // as a special message so the frontend can render an "Answered Questions" card.
  // This also avoids mixing it in with normal user chat text.
  if (workflow_context && workflow_context.plan_action === 'answer_questions') {
    userMessage.role = 'user_clarification';

    if (Array.isArray(workflow_context.clarification_answers)) {
      userMessage.clarificationAnswers = workflow_context.clarification_answers;
    }
  }

  const userAttachments = [];
  if (images && images.length > 0) {
    images.slice(0, 10).forEach((img, i) => {
      userAttachments.push({
        type: 'image',
        source: 'upload',
        label: `Image ${i + 1}`
      });
    });
  }
  if (files && files.length > 0) {
    files.forEach(f => {
      userAttachments.push({
        type: 'file',
        name: f.name,
        size: f.size || 0,
        mime_type: f.mime_type || 'text/plain'
      });
    });
  }
  if (userAttachments.length > 0) {
    userMessage.attachments = userAttachments;
  }

  let userMessagePersisted = false;
  if (save_chat && session_id) {
    try {
      await addMessagesToSession(session_id, [userMessage]);
      userMessagePersisted = true;
    } catch (err) {
      sessionLogger.warn('Failed to persist user message early', { error: err.message });
    }
  }

  // ------------------------------------------------------------------
  // 3. Resolve model configuration from MongoDB
  // ------------------------------------------------------------------
  let llmOverride = null;
  if (model) {
    try {
      const modelData = await getModelData(model);
      if (modelData) {
        // Build the LLM override from the MongoDB model document.
        // The endpoint stored in MongoDB is the base URL (e.g. http://host:port/v1).
        // The Python orchestrator uses the OpenAI SDK which appends /chat/completions
        // automatically, so we pass the base URL as-is.
        llmOverride = {
          base_url: modelData.endpoint || null,
          api_key: modelData.apiKey || null,
          model: modelData.model || model
        };
        sessionLogger.info('Resolved model config from MongoDB', {
          model: llmOverride.model,
          base_url: llmOverride.base_url,
          query_type: modelData.queryType
        });
      }
    } catch (err) {
      sessionLogger.warn('Failed to resolve model from MongoDB, orchestrator will use its default', {
        model,
        error: err.message
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. Build OrchestratorRequest
  // ------------------------------------------------------------------

  // Prepend attached file content to the query for LLM visibility
  let augmentedQuery = query;
  if (Array.isArray(files) && files.length > 0) {
    const fileParts = files.map(f => {
      return `[Attached file: ${f.name}]\n${f.content}\n[End of file: ${f.name}]`;
    });
    augmentedQuery = fileParts.join('\n\n') + '\n\n' + query;
  }

  const orchestratorRequest = {
    query: augmentedQuery,
    model: model || null,
    session_id: session_id || null,
    user_id: user_id || null,
    auth_token: auth_token || null,
    conversation_summary: conversationSummary || null,
    recent_messages: recentMessages,
    workspace_path: _workspacePathFromToken(auth_token),
    page_context: system_prompt || null,
    selected_items: [
      ...(workspace_items || []).map(item => ({
        type: 'workspace_item',
        ...item
      })),
      ...(selected_jobs || []).map(item => ({
        type: 'job',
        ...item
      })),
      ...(selected_workflows || []).map(item => ({
        type: 'workflow',
        ...item
      }))
    ],
    target_agent: target_agent || null,
    // Treat 0 (or negative) as unlimited.
    max_steps: (typeof config.agent?.max_iterations === 'number' && config.agent.max_iterations <= 0)
      ? null
      : (config.agent?.max_iterations || 5),
    ...(workflow_context ? { workflow_context } : {}),
    ...(llmOverride ? { llm_override: llmOverride } : {}),
    ...(auto_submit_preference ? { auto_submit_preference } : {}),
    // Structured file attachments for programmatic use by agents
    ...(files && files.length > 0 ? { attached_files: files.map(f => ({
      name: f.name,
      content: f.content,
      mime_type: f.mime_type || 'text/plain',
      size: f.size || 0
    })) } : {})
  };

  // ------------------------------------------------------------------
  // 5. Call the orchestrator
  // ------------------------------------------------------------------
  let state;

  if (stream && responseStream) {
    // -- Streaming path --
    try {
      state = await streamFromOrchestrator(orchestratorRequest, responseStream, shouldCancel);
    } catch (err) {
      if (err.isCancelled) throw err;

      sessionLogger.error('Orchestrator streaming failed', { error: err.message });

      // If fallback is enabled, throw so the queue worker can retry with legacy
      if (config.orchestrator?.fallback_to_legacy) {
        const fallbackErr = new Error(`Orchestrator failed: ${err.message}`);
        fallbackErr.shouldFallback = true;
        throw fallbackErr;
      }

      emitSSE(responseStream, 'error', {
        error: `Failed to reach orchestrator: ${err.message}`,
        timestamp: new Date().toISOString()
      });
      state = {
        responseText: 'I encountered an error connecting to the backend. Please try again.',
        agentsUsed: [],
        toolCalls: [],
        resultForUi: {},
        decision: 'error',
        elapsedMs: 0,
        lastAgentResult: null,
        lastToolName: null,
        lastResultForUi: null,
        mcpServerName: null,
        sentResultForUi: false,
        autoSubmitted: false,
        streamedResponse: '',
        error: null
      };
    }
  } else {
    // -- Non-streaming (batch) path --
    try {
      const batchUrl = `${ORCHESTRATOR_URL}${BATCH_ENDPOINT}`;
      const response = await axios.post(batchUrl, orchestratorRequest, {
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          ...(auth_token ? { 'Authorization': `Bearer ${auth_token}` } : {})
        }
      });
      state = {
        responseText: response.data.response_text || '',
        agentsUsed: response.data.agents_used || [],
        toolCalls: response.data.tool_calls || [],
        resultForUi: response.data.result_for_ui || {},
        decision: response.data.status || 'completed',
        elapsedMs: 0
      };
    } catch (err) {
      if (config.orchestrator?.fallback_to_legacy) {
        const fallbackErr = new Error(`Orchestrator batch failed: ${err.message}`);
        fallbackErr.shouldFallback = true;
        throw fallbackErr;
      }
      state = {
        responseText: 'I encountered an error processing your request. Please try again.',
        agentsUsed: [],
        toolCalls: [],
        resultForUi: {},
        decision: 'error',
        elapsedMs: 0,
        lastAgentResult: null,
        lastToolName: null,
        lastResultForUi: null,
        mcpServerName: null,
        sentResultForUi: false,
        autoSubmitted: false,
        streamedResponse: '',
        error: null
      };
    }
  }

  // ------------------------------------------------------------------
  // 6. Build assistant message and persist to DB
  // ------------------------------------------------------------------
  const assistantMessage = {
    message_id: uuidv4(),
    role: 'assistant',
    content: state.responseText || state.streamedResponse || '',
    timestamp: new Date().toISOString(),
    model: model || null,
    source_tool: state.agentsUsed?.[0] || null,
    ui_source_tool: state.agentsUsed?.[0] || null,
    agent_metadata: {
      orchestrator: true,
      agents_used: state.agentsUsed,
      tool_calls: state.toolCalls,
      decision: state.decision,
      elapsed_ms: state.elapsedMs
    }
  };

  // If the planner is just asking clarification questions, don't persist an empty
  // assistant message. The UI will render the clarification chips based on the
  // ask_questions SSE event, and the user's eventual answers are persisted as
  // user_clarification.
  const assistantContentEmpty = !assistantMessage.content || String(assistantMessage.content).trim() === '';
  const assistantToolName = String(assistantMessage.ui_source_tool || assistantMessage.source_tool || '');

  const isPlanningAskQuestions =
    workflow_context &&
    workflow_context.plan_action === 'ask_questions' &&
    assistantContentEmpty;

  const isPlanningAnswerQuestions =
    workflow_context &&
    workflow_context.plan_action === 'answer_questions' &&
    assistantContentEmpty;

  const isAskClarificationTool =
    assistantContentEmpty &&
    (assistantToolName.indexOf('ask_clarification') !== -1 || assistantToolName.indexOf('bvbrc_server.ask_clarification') !== -1);

  // Review steps and continue_review actions produce empty response_text
  // because the PlanCard renders the interactive review panel directly.
  const isPlanReviewStep =
    assistantContentEmpty &&
    workflow_context &&
    (workflow_context.plan_action === 'execute_next' || workflow_context.plan_action === 'continue_review');

  if (isPlanningAskQuestions || isPlanningAnswerQuestions || isAskClarificationTool || isPlanReviewStep) {
    assistantMessage._skip_persist = true;
  }

  // Attach resolved tool name for frontend routing
  if (state.lastToolName) {
    assistantMessage.source_tool = state.lastToolName;
    assistantMessage.ui_source_tool = state.lastToolName;
  }
  // Attach result_for_ui for rich rendering (data grids, workflow cards, etc.)
  if (state.resultForUi && Object.keys(state.resultForUi).length > 0) {
    const callEnvelope = _buildCallEnvelope(state.lastToolName, state.resultForUi);
    assistantMessage.tool_call = callEnvelope;
    assistantMessage.ui_tool_call = callEnvelope;
    // Also store the full result for rich rendering metadata
    assistantMessage.result_for_ui = state.resultForUi;
  }

  // ------------------------------------------------------------------
  // Attach plan metadata from the Planning Agent.
  // ------------------------------------------------------------------
  if (state.plan) {
    assistantMessage.plan = state.plan;
    assistantMessage.isPlan = true;
    assistantMessage.source_tool = 'planning_agent';
    assistantMessage.ui_source_tool = 'planning_agent';
  }

  // ------------------------------------------------------------------
  // Attach workflow metadata from Service2 planning results.
  //
  // The full manifest (with steps, params, service names) is stored so
  // that persisted messages can re-render workflow cards without
  // needing to re-fetch from the workflow engine.  The frontend reads
  // ``message.workflowData`` (aliased from ``message.workflow`` on
  // load) and expects at minimum: workflow_id, workflow_name, steps[],
  // execution_metadata.{status, is_planned, workflow_id}.
  // ------------------------------------------------------------------
  const rui = state.resultForUi || {};
  const workflowId = rui.workflow_id || null;
  const workflowPersisted = rui.persisted === true;
  const manifest = rui.manifest || null;
  const workflowPlan = rui.workflow_plan || null;
  const workflowName = manifest?.workflow_name || workflowPlan?.workflow_name || null;
  const steps = manifest?.steps || workflowPlan?.steps || [];

  // Determine workflow status based on whether it was auto-submitted
  const wasAutoSubmitted = !!state.autoSubmitted;
  const workflowStatus = wasAutoSubmitted ? 'pending' : 'planned';

  // Collect all submission IDs (batch support)
  const submissionIds = rui.submission_ids || (rui.submission_id ? [rui.submission_id] : []);

  if (workflowId && workflowPersisted) {
    assistantMessage.workflow = {
      workflow_id: workflowId,
      workflow_name: workflowName,
      status: workflowStatus,
      persisted: true,
      auto_submitted: wasAutoSubmitted,
      submission_ids: submissionIds,
      steps,
      step_count: steps.length,
      execution_metadata: {
        workflow_id: workflowId,
        status: workflowStatus,
        is_planned: !wasAutoSubmitted,
        is_submitted: wasAutoSubmitted,
      },
    };
    // Include the full manifest so the workflow card can render params
    if (manifest) {
      assistantMessage.workflow.manifest = manifest;
    }

    // Also store as workflowData so the frontend can find it directly
    assistantMessage.workflowData = assistantMessage.workflow;

    // Register workflow_id on the session for session-level tracking
    if (session_id) {
      addWorkflowIdToSession(session_id, workflowId).catch(err => {
        sessionLogger.warn('Failed to add workflow_id to session', {
          workflow_id: workflowId,
          error: err.message
        });
      });
    }

    // Register workflow watches so the Bull queue poller monitors completion.
    // Handles both single (submission_id) and batch (submission_ids) submissions.
    if (wasAutoSubmitted && session_id) {
      const submissionIds = rui.submission_ids || (rui.submission_id ? [rui.submission_id] : []);
      for (const subId of submissionIds) {
        registerWorkflowWatch({
          submission_id: subId,
          workflow_id: workflowId || '',
          session_id,
          user_id: user_id || '',
          auth_token: auth_token || null,
        }).catch(err => {
          sessionLogger.warn('Failed to register workflow watch', {
            submission_id: subId,
            error: err.message
          });
        });
        // Also track each submission_id on the session
        addWorkflowIdToSession(session_id, subId).catch(() => {});
      }
      sessionLogger.info('Registered workflow watches', {
        count: submissionIds.length,
        submission_ids: submissionIds
      });
    }

    sessionLogger.info('Workflow metadata attached to message', {
      workflow_id: workflowId,
      status: workflowStatus,
      auto_submitted: wasAutoSubmitted
    });
  } else if (workflowId && !workflowPersisted) {
    // Persistence failed — record on message so frontend can show warning
    assistantMessage.workflow = {
      workflow_id: workflowId,
      workflow_name: workflowName,
      status: workflowStatus,
      persisted: false,
      auto_submitted: wasAutoSubmitted,
      submission_ids: submissionIds,
      steps,
      step_count: steps.length,
      execution_metadata: {
        workflow_id: workflowId,
        status: workflowStatus,
        is_planned: !wasAutoSubmitted,
        is_submitted: wasAutoSubmitted,
      },
    };
    if (manifest) {
      assistantMessage.workflow.manifest = manifest;
    }
    assistantMessage.workflowData = assistantMessage.workflow;

    sessionLogger.warn('Workflow planned but not persisted to engine', {
      workflow_id: workflowId,
      auto_submitted: wasAutoSubmitted
    });
  }

  // Save to database
  if (save_chat && session_id) {
    try {
      if (!chatSession) {
        await createChatSession(session_id, user_id);
      }

      let messagesToSave = userMessagePersisted
        ? [assistantMessage]
        : [userMessage, assistantMessage];

      // See assistantMessage._skip_persist above.
      messagesToSave = messagesToSave.filter(m => !(m && m._skip_persist === true));

      if (messagesToSave.length > 0) {
        await addMessagesToSession(session_id, messagesToSave);
      }
      sessionLogger.info('Saved messages to session', {
        count: messagesToSave.length,
        session_id
      });

      // Trigger summary if needed
      const messageCount = (chatSession?.messages?.length || 0) + messagesToSave.length;
      maybeQueueSummary({ session_id, user_id, messageCount }).catch(err => {
        sessionLogger.warn('Failed to queue summary', { error: err.message });
      });
    } catch (err) {
      sessionLogger.error('Failed to save chat', { error: err.message });
    }
  }

  // ------------------------------------------------------------------
  // 7. Finalize SSE stream
  // ------------------------------------------------------------------
  if (stream && responseStream) {
    sessionLogger.info('Finalizing SSE stream', {
      hasStreamedResponse: !!state.streamedResponse,
      streamedResponseLength: (state.streamedResponse || '').length,
      hasResponseText: !!state.responseText,
      responseTextLength: (state.responseText || '').length,
      responseTextPreview: (state.responseText || '').substring(0, 200),
      agentsUsed: state.agentsUsed,
      decision: state.decision
    });

    // If no synthesis_chunk events were emitted (e.g. direct response),
    // send the full response as a single final_response event
    // Skip if responseText is empty or whitespace only
    const hasValidResponseText = state.responseText && state.responseText.trim() !== '';
    if (!state.streamedResponse && hasValidResponseText) {
      const payload = {
        chunk: state.responseText,
        tool: state.lastToolName || state.agentsUsed?.[0] || null,
      };
      if (state.lastResultForUi) {
        payload.call = _buildCallEnvelope(state.lastToolName, state.lastResultForUi);
      }
      emitSSE(responseStream, 'final_response', payload);
    }

    // Don't emit 'done' or call end() here.
    // The queue worker emits 'done' after this function returns.

    return {
      iterations: state.toolCalls?.length || 0,
      toolsUsed: state.agentsUsed || [],
      message_id: assistantMessage.message_id
    };
  }

  // Non-streaming return
  return {
    message: 'success',
    userMessage,
    assistantMessage,
    agent_metadata: {
      orchestrator: true,
      agents_used: state.agentsUsed,
      tool_calls: state.toolCalls,
      decision: state.decision,
      elapsed_ms: state.elapsedMs
    }
  };
}


// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if the Python orchestrator is reachable and healthy.
 * @returns {object} Health status
 */
async function checkOrchestratorHealth() {
  try {
    const url = `${ORCHESTRATOR_URL}${HEALTH_ENDPOINT}`;
    const response = await axios.get(url, { timeout: 5000 });
    return {
      healthy: response.status === 200,
      status: response.data?.status || 'unknown',
      agents: response.data?.agents || {},
      llm: response.data?.llm || {}
    };
  } catch (err) {
    return {
      healthy: false,
      status: 'unreachable',
      error: err.message
    };
  }
}


module.exports = {
  executeOrchestratorLoop,
  checkOrchestratorHealth,
  streamFromOrchestrator,
  ORCHESTRATOR_URL
};
