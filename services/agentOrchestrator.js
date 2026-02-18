// services/agentOrchestrator.js

const { v4: uuidv4 } = require('uuid');
const { executeMcpTool, isFinalizeTool, isRagTool } = require('./mcp/mcpExecutor');
const { loadToolsForPrompt } = require('./mcp/toolDiscovery');
const {
  getModelData,
  getChatSession,
  createChatSession,
  addMessagesToSession,
  addWorkflowIdToSession
} = require('./dbUtils');
const {
  queryChatOnly,
  queryChatImage,
  LLMServiceError,
  setupOpenaiClient,
  postJsonStream
} = require('./llmServices');
const { safeParseJson } = require('./jsonUtils');
const promptManager = require('../prompts');
const config = require('../config.json');
const mcpConfig = require('./mcp/config.json');
const { createLogger } = require('./logger');
const fs = require('fs').promises;
const { emitSSE: emitSSEUtil } = require('./sseUtils');
const { buildConversationContext } = require('./memory/conversationContextService');
const { maybeQueueSummary } = require('./summaryQueueService');
const { maybeQueueSessionFacts } = require('./sessionFactsQueueService');
const { getSessionMemory, updateSessionMemory, formatSessionMemory } = require('./memory/sessionMemoryService');

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
 * Extract workflow_id from a workflow tool result
 * Handles various result structures from workflow tools (plan_workflow, submit_workflow)
 * Including MCP wrappers
 */
function extractWorkflowId(result) {
  if (!result) return null;

  // Direct workflow_id field (most common after unwrapping)
  if (result.workflow_id && typeof result.workflow_id === 'string') {
    return result.workflow_id.trim();
  }

  // Check in content wrapper (MCP format: content[0].text contains JSON string)
  if (result.content && Array.isArray(result.content) && result.content.length > 0) {
    const firstContent = result.content[0];
    if (firstContent.text) {
      try {
        const parsed = JSON.parse(firstContent.text);
        if (parsed.workflow_id && typeof parsed.workflow_id === 'string') {
          return parsed.workflow_id.trim();
        }
      } catch (e) {
        // Not JSON or parse failed, continue
      }
    }
  }

  // Check in structuredContent
  if (result.structuredContent && result.structuredContent.result) {
    const structuredResult = result.structuredContent.result;
    if (typeof structuredResult === 'string') {
      try {
        const parsed = JSON.parse(structuredResult);
        if (parsed.workflow_id && typeof parsed.workflow_id === 'string') {
          return parsed.workflow_id.trim();
        }
      } catch (e) {
        // Not JSON or parse failed
      }
    } else if (typeof structuredResult === 'object' && structuredResult.workflow_id) {
      return structuredResult.workflow_id.trim();
    }
  }

  // If result is itself a JSON string
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && parsed.workflow_id && typeof parsed.workflow_id === 'string') {
        return parsed.workflow_id.trim();
      }
    } catch (e) {
      // Not JSON, ignore.
    }
  }

  return null;
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

function toBooleanFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function buildImageContextLabel(imageData) {
  if (typeof imageData !== 'string') {
    return 'Attached image';
  }
  if (imageData.startsWith('data:image/png')) {
    return 'Attached PNG image';
  }
  if (imageData.startsWith('data:image/jpeg') || imageData.startsWith('data:image/jpg')) {
    return 'Attached JPEG image';
  }
  if (imageData.startsWith('data:image/webp')) {
    return 'Attached WEBP image';
  }
  if (imageData.startsWith('data:image/gif')) {
    return 'Attached GIF image';
  }
  return 'Attached image';
}

function normalizeImagesInput(images, maxImages = 10) {
  const normalized = [];

  if (Array.isArray(images)) {
    for (const entry of images) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        normalized.push(entry);
      }
    }
  }

  if (normalized.length === 0) {
    return [];
  }

  return normalized.slice(0, maxImages);
}

async function summarizeImageContext({
  image,
  query,
  model,
  systemPrompt = '',
  historyContext = '',
  sessionMemory = null,
  workspace_items = null,
  selected_jobs = null,
  selected_workflows = null,
  logger
}) {
  if (!image) {
    return { summary: '', modelUsed: null, skipped: false, notice: null };
  }

  const log = logger || createLogger('Agent-ImageContext');
  const modelData = await getModelData(model);

  if (!toBooleanFlag(modelData.supports_image)) {
    const notice = 'Image analysis skipped because the selected model does not support images.';
    log.info(notice, { model });
    return { summary: '', modelUsed: null, skipped: true, notice };
  }

  const historyStr = historyContext
    ? `\n\nConversation history (for context):\n${historyContext}`
    : '';

  const sessionMemoryStr = sessionMemory
    ? `\n\nSession facts:\n${formatSessionMemory(sessionMemory)}`
    : '';

  const workspaceStr = workspace_items && Array.isArray(workspace_items) && workspace_items.length > 0
    ? `\n\nWorkspace files (for context):\n${JSON.stringify(workspace_items, null, 2)}`
    : '';

  const selectedJobsStr = selected_jobs && Array.isArray(selected_jobs) && selected_jobs.length > 0
    ? `\n\nSelected jobs (for context):\n${JSON.stringify(selected_jobs, null, 2)}`
    : '';

  const selectedWorkflowsStr = selected_workflows && Array.isArray(selected_workflows) && selected_workflows.length > 0
    ? `\n\nSelected workflows (for context):\n${JSON.stringify(selected_workflows, null, 2)}`
    : '';

  const imageInstruction = [
    'You are extracting visual context for a downstream BV-BRC tool-using agent.',
    'Return plain text only.',
    'Summarize only what is visible in the image and context-relevant to the user query.',
    'Include labels, values, IDs, table columns, file names, statuses, and actionable UI controls when present.',
    'Explicitly mention uncertainty for ambiguous items.',
    '',
    'User query:',
    query || '',
    '',
    'System context:',
    systemPrompt || 'No additional context',
    historyStr,
    sessionMemoryStr,
    workspaceStr,
    selectedJobsStr,
    selectedWorkflowsStr
  ].join('\n');

  const summary = await queryChatImage({
    url: modelData.endpoint,
    model,
    query: imageInstruction,
    image,
    system_prompt: 'Extract accurate visual context for planning and final response generation.'
  });

  return {
    summary: typeof summary === 'string' ? summary.trim() : '',
    modelUsed: model,
    skipped: false,
    notice: 'Image context analyzed and integrated into agent reasoning.'
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
    'bvbrc_server.query_collection',
    'bvbrc_server.bvbrc_global_data_search'
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
 * Remove MCP tool identifiers from text before it is sent to final response generation.
 */
function sanitizeToolNames(text) {
  if (typeof text !== 'string' || !text) return text;

  return text
    // Common MCP tool id format: server_name.tool_name
    .replace(/\b[a-zA-Z0-9_-]+(?:_server)?\.[a-zA-Z0-9_.-]+\b/g, '[tool]')
    // Defensive cleanup for internal server mentions in free text
    .replace(/\binternal_server\b/gi, 'internal system')
    .replace(/\bmcp\b/gi, 'internal system');
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
    max_iterations = 3,
    auth_token = null,
    workspace_items = null,
    selected_jobs = null,
    selected_workflows = null,
    images = null,
    stream = false,
    responseStream = null,
    progressCallback = null,
    shouldCancel = () => false
  } = opts;

  const normalizedImages = normalizeImagesInput(images, 10);
  const imageCount = normalizedImages.length;

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
    max_iterations,
    has_image: imageCount > 0,
    image_count: imageCount,
    has_workspace_items: !!workspace_items,
    workspace_items_count: workspace_items ? workspace_items.length : 0,
    has_selected_jobs: !!selected_jobs,
    selected_jobs_count: Array.isArray(selected_jobs) ? selected_jobs.length : 0,
    has_selected_workflows: !!selected_workflows,
    selected_workflows_count: Array.isArray(selected_workflows) ? selected_workflows.length : 0
  });

  // Log workspace items if present
  if (workspace_items && Array.isArray(workspace_items) && workspace_items.length > 0) {
    logger.info('Workspace items available for this query', {
      count: workspace_items.length,
      items: workspace_items.map(item => ({
        type: item.type,
        path: item.path,
        name: item.name,
        has_content: !!item.content
      }))
    });
  }

  if (selected_jobs && Array.isArray(selected_jobs) && selected_jobs.length > 0) {
    logger.info('Selected jobs available for this query', {
      count: selected_jobs.length,
      job_ids: selected_jobs.map(item => item && item.id).filter(Boolean)
    });
  }
  if (selected_workflows && Array.isArray(selected_workflows) && selected_workflows.length > 0) {
    logger.info('Selected workflows available for this query', {
      count: selected_workflows.length,
      workflow_ids: selected_workflows.map(item => item && (item.workflow_id || item.id)).filter(Boolean)
    });
  }

  const executionTrace = [];
  const toolResults = {};
  const collectedRagDocs = [];
  let iteration = 0;
  let finalResponseSourceTool = null; // Track which tool generated the final response
  let finalResponse = null;
  let sessionMemory = null;
  let queryForAgent = query;
  let imageContextNotice = null;

  // Get auth token (from opts or config)
  const authToken = auth_token || config.auth_token;

  // Get or create chat session early so tool-side metadata writes (e.g. workflow_ids)
  // always have an existing chat_sessions document to update.
  let chatSession = null;
  let historyContext = '';
  if (session_id) {
    chatSession = await getChatSession(session_id);
    if (!chatSession) {
      try {
        await createChatSession(session_id, user_id);
        chatSession = await getChatSession(session_id);
        logger.info('Created chat session at start of agent loop', { session_id, user_id });
      } catch (createError) {
        logger.warn('Failed to create chat session at start, will retry on save', {
          session_id,
          error: createError.message
        });
      }
    }
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

  if (session_id) {
    try {
      sessionMemory = await getSessionMemory(session_id, user_id);
    } catch (error) {
      logger.warn('Failed to load session memory, proceeding without it', { error: error.message });
    }
  }

  if (imageCount > 0) {
    try {
      if (Array.isArray(images) && images.length > 10) {
        const truncationNotice = 'Only the first 10 images were used for backend processing.';
        if (stream && responseStream) {
          emitSSE(responseStream, 'image_context', {
            message: truncationNotice,
            skipped: false
          });
        }
      }

      const summaries = [];
      for (let idx = 0; idx < normalizedImages.length; idx++) {
        const imageSummaryResult = await summarizeImageContext({
          image: normalizedImages[idx],
          query,
          model,
          systemPrompt: system_prompt,
          historyContext,
          sessionMemory,
          workspace_items,
          selected_jobs,
          selected_workflows,
          logger
        });

        imageContextNotice = imageSummaryResult.notice || imageContextNotice;
        if (imageContextNotice && stream && responseStream) {
          emitSSE(responseStream, 'image_context', {
            message: `[Image ${idx + 1}/${normalizedImages.length}] ${imageContextNotice}`,
            skipped: !!imageSummaryResult.skipped
          });
        }

        if (imageSummaryResult.summary) {
          summaries.push(`[Image ${idx + 1}] ${imageSummaryResult.summary}`);
          logger.info('Prepared image context chunk for agent loop', {
            image_index: idx + 1,
            image_summary_length: imageSummaryResult.summary.length,
            image_summary_model: imageSummaryResult.modelUsed
          });
        }
      }

      if (summaries.length > 0) {
        queryForAgent = `${query}\n\nVisual context from attached images:\n${summaries.join('\n\n')}`;
      }
    } catch (imageError) {
      logger.warn('Failed to summarize image context, proceeding with text-only query', {
        error: imageError.message
      });
    }
  }

  // Create user message
  const userMessage = createMessage('user', query);
  if (imageCount > 0) {
    userMessage.attachments = normalizedImages.map((img) => ({
      type: 'image',
      source: 'upload',
      label: buildImageContextLabel(img)
    }));
  }
  let userMessagePersisted = false;

  const throwIfCancelled = (checkpoint) => {
    if (!shouldCancel()) return;
    const cancelError = new Error(`Job cancelled by user (${checkpoint})`);
    cancelError.name = 'JobCancelledError';
    cancelError.isCancelled = true;
    throw cancelError;
  };

  try {
    // Persist the user message immediately so aborted/cancelled jobs still keep user intent.
    if (save_chat && session_id) {
      try {
        if (!chatSession) {
          await createChatSession(session_id, user_id);
          chatSession = await getChatSession(session_id);
        }
        await addMessagesToSession(session_id, [userMessage]);
        userMessagePersisted = true;
        logger.info('Persisted user message at start of agent loop', {
          session_id,
          message_id: userMessage.message_id
        });
      } catch (initialSaveError) {
        logger.warn('Failed to persist user message at start; will retry at completion', {
          session_id,
          error: initialSaveError.message
        });
      }
    }

    while (iteration < max_iterations) {
      throwIfCancelled('before_iteration');
      iteration++;
      logger.info(`=== Iteration ${iteration}/${max_iterations} ===`);

      // Plan next action (with optional history)
      let nextAction = await planNextAction(
        queryForAgent,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        historyContext,
        sessionMemory,
        workspace_items,
        selected_jobs,
        selected_workflows,
        logger
      );
      throwIfCancelled('after_planning');

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
        throwIfCancelled('before_finalize_generation');
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
          null, // No specific tool for FINALIZE action
          sessionMemory,
          workspace_items,
          selected_jobs,
          selected_workflows
        );
        break;
      }

      // Execute the tool
      try {
        if (typeof progressCallback === 'function') {
          progressCallback(iteration, nextAction.action, 'active');
        }
        throwIfCancelled('before_tool_execution');

        const result = await executeMcpTool(
          nextAction.action,
          nextAction.parameters,
          authToken,
          {
            query: queryForAgent,
            model,
            system_prompt,
            session_id,
            user_id,
            historyContext,
            sessionMemory,
            workspace_items,
            selected_jobs,
            selected_workflows,
            responseStream: stream && responseStream ? responseStream : null,
            shouldCancel
          },
          logger
        );
        throwIfCancelled('after_tool_execution');

        const { storage: ragStorage, safeResult } = prepareToolResult(
          nextAction.action,
          result,
          mcpConfig.global_settings?.rag_max_docs
        );

        if (ragStorage) {
          collectedRagDocs.push(ragStorage);
        }

        const isErrorResult = !!(
          safeResult &&
          typeof safeResult === 'object' &&
          (safeResult.isError === true || safeResult.error === true)
        );

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
        traceEntry.status = isErrorResult ? 'error' : 'success';

        if (session_id) {
          try {
            sessionMemory = await updateSessionMemory({
              session_id,
              user_id,
              toolId: nextAction.action,
              parameters: nextAction.parameters,
              result: safeResult
            });
          } catch (memoryError) {
            logger.warn('Failed to update session memory', { error: memoryError.message });
          }
        }

        // Store workflow IDs directly on chat_sessions for straightforward retrieval.
        if (session_id && nextAction.action && nextAction.action.includes('submit_workflow')) {
          logger.debug('Attempting to extract workflow ID', {
            tool: nextAction.action,
            resultType: typeof safeResult,
            hasContent: !!safeResult?.content,
            hasStructuredContent: !!safeResult?.structuredContent,
            hasWorkflowIdField: !!safeResult?.workflow_id,
            resultPreview: safeResult ? JSON.stringify(safeResult).substring(0, 300) : 'null'
          });

          const workflowId = extractWorkflowId(safeResult);

          if (workflowId) {
            try {
              await addWorkflowIdToSession(session_id, workflowId);
              logger.info('Stored workflow ID on chat session', { session_id, workflow_id: workflowId });
            } catch (workflowError) {
              logger.warn('Failed to store workflow ID on chat session', { error: workflowError.message, workflow_id: workflowId });
            }
          } else {
            logger.warn('No workflow ID found in workflow submission result', {
              session_id,
              tool: nextAction.action,
              resultType: typeof safeResult,
              resultKeys: safeResult && typeof safeResult === 'object' ? Object.keys(safeResult) : []
            });
          }
        }

        if (session_id) {
          maybeQueueSessionFacts({
            session_id,
            user_id,
            user_query: queryForAgent,
            model,
            toolId: nextAction.action,
            parameters: nextAction.parameters,
            result: safeResult
          }).catch((factsError) => {
            logger.warn('Failed to queue session facts update', { error: factsError.message });
          });
        }

        logger.logToolExecution(
          nextAction.action,
          nextAction.parameters,
          safeResult,
          traceEntry.status
        );

        logger.logAgentIteration(
          iteration,
          nextAction.action,
          nextAction.reasoning,
          nextAction.parameters,
          safeResult,
          traceEntry.status
        );

        // Emit SSE event for tool execution result
        if (stream && responseStream) {
          emitSSE(responseStream, 'tool_executed', {
            iteration,
            tool: nextAction.action,
            status: traceEntry.status,
            result: safeResult
          });

          // Emit a dedicated event for newly-created session files so clients
          // can update file UIs immediately without parsing generic tool payloads.
          if (safeResult && safeResult.type === 'file_reference') {
            emitSSE(responseStream, 'session_file_created', {
              iteration,
              session_id,
              tool: nextAction.action,
              file: {
                file_id: safeResult.file_id,
                file_name: safeResult.fileName || null,
                is_error: safeResult.isError === true,
                summary: safeResult.summary || null,
                workspace: safeResult.workspace || null
              },
              timestamp: new Date().toISOString()
            });
          }
        }

        // Tools marked as FINALIZE should finalize immediately
        const shouldFinalizeNow = isFinalizeTool(nextAction.action);
        if (shouldFinalizeNow) {
          throwIfCancelled('before_finalize_tool_emit');
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
        if (error && error.isCancelled) {
          throw error;
        }

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
          queryForAgent,
            system_prompt,
            executionTrace,
            toolResults,
            model,
            historyContext,
            stream,
            responseStream,
            logger,
            null, // Error case, no specific tool
            sessionMemory,
            workspace_items,
            selected_jobs,
            selected_workflows
          );
          break;
        }
      }
    }

    // Safety net: hit max iterations
    if (!finalResponse) {
      throwIfCancelled('before_max_iteration_finalize');
      logger.warn('Max iterations reached, finalizing');
      finalResponse = await generateFinalResponse(
        queryForAgent,
        system_prompt,
        executionTrace,
        toolResults,
        model,
        historyContext,
        stream,
        responseStream,
        logger,
        null, // Max iterations, no specific tool
        sessionMemory,
        workspace_items,
        selected_jobs,
        selected_workflows
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
        const baseMessages = dbSystemMessage
          ? [dbSystemMessage, assistantMessage]
          : [assistantMessage];
        const messagesToSave = userMessagePersisted
          ? baseMessages
          : [userMessage].concat(baseMessages);

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
      ...(imageContextNotice && { image_context_notice: imageContextNotice }),
      agent_metadata: {
        iterations: iteration,
        tools_used: Object.keys(toolResults).length,
        execution_trace: executionTrace
      }
    };
  } catch (error) {
    if (error && error.isCancelled) {
      logger.info('Agent loop cancelled', { error: error.message });
      throw error;
    }

    logger.error('Agent loop failed', { error: error.message, stack: error.stack });
    throw new LLMServiceError('Agent loop failed', error);
  }
}

/**
 * Plan the next action using LLM
 */
async function planNextAction(query, systemPrompt, executionTrace, toolResults, model, historyContext = '', sessionMemory = null, workspace_items = null, selected_jobs = null, selected_workflows = null, logger = null) {
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
                const isErrorRef = value.isError === true || value.error === true;
                return [key, isErrorRef ? {
                  type: 'ERROR_SAVED',
                  file_id: value.file_id,
                  errorType: value.errorType,
                  errorMessage: value.errorMessage,
                  local_tmp_path: value.filePath || null,
                  message: 'Tool returned an error payload saved to a local /tmp session file.',
                  note: 'Tool returned an error payload saved to file. Inspect it with internal_server file tools and adjust inputs/tool choice.'
                } : {
                  type: 'FILE_SAVED',
                  file_id: value.file_id,
                  summary: value.summary,
                  local_tmp_path: value.filePath || null,
                  message: 'Result saved to a local /tmp session file.',
                  note: 'Result saved to a local /tmp session file. Prefer local_tmp_path for any downstream file access.'
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

    const sessionMemoryStr = sessionMemory
      ? formatSessionMemory(sessionMemory)
      : 'No session memory available';

    // Format workspace items if available
    const workspaceStr = workspace_items && Array.isArray(workspace_items) && workspace_items.length > 0
      ? `\n\nWORKSPACE FILES (available for reference):\n${JSON.stringify(workspace_items, null, 2)}\n\nThese files are in the user's workspace and may be relevant to the query.`
      : '';

    const selectedJobsStr = selected_jobs && Array.isArray(selected_jobs) && selected_jobs.length > 0
      ? `\n\nSELECTED JOBS (available for reference):\n${JSON.stringify(selected_jobs, null, 2)}\n\nThese jobs were selected by the user in chat and may be relevant to the query.`
      : '';

    const selectedWorkflowsStr = selected_workflows && Array.isArray(selected_workflows) && selected_workflows.length > 0
      ? `\n\nSELECTED WORKFLOWS (available for reference):\n${JSON.stringify(selected_workflows, null, 2)}\n\nThese workflows were selected by the user in chat and may be relevant to the query.`
      : '';

    // Log workspace items inclusion in prompt
    if (workspaceStr) {
      logger.info('Including workspace items in planning prompt', {
        workspace_items_count: workspace_items.length,
        workspace_str_length: workspaceStr.length,
        items_summary: workspace_items.map(item => ({
          type: item.type,
          path: item.path,
          name: item.name
        }))
      });
    }

    if (selectedJobsStr) {
      logger.info('Including selected jobs in planning prompt', {
        selected_jobs_count: selected_jobs.length,
        selected_jobs_str_length: selectedJobsStr.length,
        job_ids: selected_jobs.map(item => item && item.id).filter(Boolean)
      });
    } else {
      logger.debug('No selected jobs to include in planning prompt', {
        selected_jobs_provided: !!selected_jobs,
        is_array: Array.isArray(selected_jobs),
        length: selected_jobs ? selected_jobs.length : 0
      });
    }
    if (selectedWorkflowsStr) {
      logger.info('Including selected workflows in planning prompt', {
        selected_workflows_count: selected_workflows.length,
        selected_workflows_str_length: selectedWorkflowsStr.length,
        workflow_ids: selected_workflows.map(item => item && (item.workflow_id || item.id)).filter(Boolean)
      });
    } else {
      logger.debug('No selected workflows to include in planning prompt', {
        selected_workflows_provided: !!selected_workflows,
        is_array: Array.isArray(selected_workflows),
        length: selected_workflows ? selected_workflows.length : 0
      });
    }

    if (!workspaceStr) {
      logger.debug('No workspace items to include in planning prompt', {
        workspace_items_provided: !!workspace_items,
        is_array: Array.isArray(workspace_items),
        length: workspace_items ? workspace_items.length : 0
      });
    }

    // Build planning prompt
    const finalSystemPrompt = (systemPrompt || 'No additional context') + historyStr + workspaceStr + selectedJobsStr + selectedWorkflowsStr;

    // Log the final system prompt composition
    logger.debug('Building planning prompt with system context', {
      base_system_prompt_length: (systemPrompt || 'No additional context').length,
      history_str_length: historyStr.length,
      workspace_str_length: workspaceStr.length,
      selected_jobs_str_length: selectedJobsStr.length,
      selected_workflows_str_length: selectedWorkflowsStr.length,
      final_system_prompt_length: finalSystemPrompt.length,
      has_workspace_in_prompt: finalSystemPrompt.includes('WORKSPACE FILES')
    });

    const planningPrompt = promptManager.formatPrompt(
      promptManager.getAgentPrompt('taskPlanning'),
      {
        tools: toolsDescription,
        executionTrace: traceStr,
        toolResults: resultsStr,
        sessionMemory: sessionMemoryStr,
        query: query,
        systemPrompt: finalSystemPrompt
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
async function generateFinalResponse(query, systemPrompt, executionTrace, toolResults, model, historyContext = '', stream = false, responseStream = null, logger = null, sourceTool = null, sessionMemory = null, workspace_items = null, selected_jobs = null, selected_workflows = null) {
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

    // Format session memory if available
    const sessionMemoryStr = sessionMemory
      ? `\n\nSession Facts:\n${formatSessionMemory(sessionMemory)}`
      : '';

    // Format workspace items if available
    const workspaceStr = workspace_items && Array.isArray(workspace_items) && workspace_items.length > 0
      ? `\n\nWORKSPACE FILES (available for reference):\n${JSON.stringify(workspace_items, null, 2)}\n\nThese files are in the user's workspace and may be relevant to the query.`
      : '';

    const selectedJobsStr = selected_jobs && Array.isArray(selected_jobs) && selected_jobs.length > 0
      ? `\n\nSELECTED JOBS (available for reference):\n${JSON.stringify(selected_jobs, null, 2)}\n\nThese jobs were selected by the user in chat and may be relevant to the query.`
      : '';

    const selectedWorkflowsStr = selected_workflows && Array.isArray(selected_workflows) && selected_workflows.length > 0
      ? `\n\nSELECTED WORKFLOWS (available for reference):\n${JSON.stringify(selected_workflows, null, 2)}\n\nThese workflows were selected by the user in chat and may be relevant to the query.`
      : '';

    // Log workspace items inclusion in final response prompt
    if (workspaceStr) {
      log.info('Including workspace items in final response prompt', {
        workspace_items_count: workspace_items.length,
        workspace_str_length: workspaceStr.length,
        items_summary: workspace_items.map(item => ({
          type: item.type,
          path: item.path,
          name: item.name
        }))
      });
    }

    if (selectedJobsStr) {
      log.info('Including selected jobs in final response prompt', {
        selected_jobs_count: selected_jobs.length,
        selected_jobs_str_length: selectedJobsStr.length,
        job_ids: selected_jobs.map(item => item && item.id).filter(Boolean)
      });
    } else {
      log.debug('No selected jobs to include in final response prompt', {
        selected_jobs_provided: !!selected_jobs,
        is_array: Array.isArray(selected_jobs),
        length: selected_jobs ? selected_jobs.length : 0
      });
    }
    if (selectedWorkflowsStr) {
      log.info('Including selected workflows in final response prompt', {
        selected_workflows_count: selected_workflows.length,
        selected_workflows_str_length: selectedWorkflowsStr.length,
        workflow_ids: selected_workflows.map(item => item && (item.workflow_id || item.id)).filter(Boolean)
      });
    } else {
      log.debug('No selected workflows to include in final response prompt', {
        selected_workflows_provided: !!selected_workflows,
        is_array: Array.isArray(selected_workflows),
        length: selected_workflows ? selected_workflows.length : 0
      });
    }

    if (!workspaceStr) {
      log.debug('No workspace items to include in final response prompt', {
        workspace_items_provided: !!workspace_items,
        is_array: Array.isArray(workspace_items),
        length: workspace_items ? workspace_items.length : 0
      });
    }

    let promptToUse;

    if (isDirectResponse) {
      const hasHistoryContext = typeof historyContext === 'string' && historyContext.trim().length > 0;
      const followUpInstruction = hasHistoryContext
        ? '\n\nFOLLOW-UP TURN INSTRUCTION:\nThis conversation is already in progress. Continue naturally from prior context and do NOT start with a greeting or re-introduce yourself.'
        : '';

      const finalHistoryContext = historyStr + sessionMemoryStr + workspaceStr + selectedJobsStr + selectedWorkflowsStr;

      // Log the final context composition
      log.debug('Building direct response prompt with context', {
        history_str_length: historyStr.length,
        session_memory_str_length: sessionMemoryStr.length,
        workspace_str_length: workspaceStr.length,
        selected_jobs_str_length: selectedJobsStr.length,
        selected_workflows_str_length: selectedWorkflowsStr.length,
        final_history_context_length: finalHistoryContext.length,
        has_workspace_in_context: finalHistoryContext.includes('WORKSPACE FILES')
      });

      // Use direct response prompt for conversational queries
      promptToUse = promptManager.formatPrompt(
        promptManager.getAgentPrompt('directResponse'),
        {
          query: query,
          systemPrompt: systemPrompt || 'No additional context',
          historyContext: finalHistoryContext,
          followUpInstruction
        }
      );
    } else {
      // Tool-based response: include trace and results without exposing MCP tool identities.
      const traceStr = executionTrace.map((t, index) =>
        `Step ${index + 1} (Iteration ${t.iteration}): ${sanitizeToolNames(t.reasoning || '')} [${t.status || 'pending'}]`
      ).join('\n');

      // Format gathered results while omitting MCP tool IDs and internal tool instructions.
      const resultsStr = Object.values(toolResults).map((result, index) => {
        const sourceLabel = `Result Source ${index + 1}`;

        // Check if this is a file reference (expected for all results)
        if (result && result.type === 'file_reference') {
          if (result.isError === true || result.error === true) {
            return `${sourceLabel}:\n[ERROR SAVED]\n` +
                   `File ID: ${result.file_id}\n` +
                   `${result.errorType ? `Error Type: ${result.errorType}\n` : ''}` +
                   `${result.errorMessage ? `Error Message: ${result.errorMessage}\n` : ''}` +
                   `Error payload was captured for this step.\n`;
          }
          return `${sourceLabel}:\n[FILE SAVED - ${result.summary.recordCount} records, ${result.summary.sizeFormatted}]\n` +
                 `Data Type: ${result.summary.dataType}\n` +
                 `Fields: ${result.summary.fields.join(', ')}\n` +
                 `Sample Record: ${JSON.stringify(result.summary.sampleRecord, null, 2)}\n` +
                 `File ID: ${result.file_id}\n`;
        }

        // Fallback for non-file-reference results (should be rare/error cases)
        const resultStr = sanitizeToolNames(JSON.stringify(result, null, 2));
        if (resultStr.length > 3000) {
          return `${sourceLabel}:\n[Result - ${resultStr.length} chars]\n${resultStr.substring(0, 3000)}...\n`;
        }
        return `${sourceLabel}:\n${resultStr}\n`;
      }).join('\n---\n');

      const finalSystemPrompt = (systemPrompt || 'No additional context') + sessionMemoryStr + workspaceStr + selectedJobsStr + selectedWorkflowsStr;

      // Log the final system prompt composition
      log.debug('Building tool-based response prompt with system context', {
        base_system_prompt_length: (systemPrompt || 'No additional context').length,
        session_memory_str_length: sessionMemoryStr.length,
        workspace_str_length: workspaceStr.length,
        selected_jobs_str_length: selectedJobsStr.length,
        selected_workflows_str_length: selectedWorkflowsStr.length,
        final_system_prompt_length: finalSystemPrompt.length,
        has_workspace_in_prompt: finalSystemPrompt.includes('WORKSPACE FILES')
      });

      // Build response prompt
      promptToUse = promptManager.formatPrompt(
        promptManager.getAgentPrompt('finalResponse'),
        {
          query: query,
          executionTrace: traceStr,
          toolResults: resultsStr || 'No tool results available',
          systemPrompt: finalSystemPrompt
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

    // Handle argo-based models
    if (modelData.queryType === 'argo') {
      const payload = {
        model: model,
        prompt: [prompt],
        system: systemPromptText,
        user: "cucinell",
        temperature: 1.0,
        stream: true
      };

      let fullResponse = '';
      const onChunk = (text) => {
        fullResponse += text;
        emitSSE(responseStream, 'final_response', { chunk: text, tool: sourceTool || null });
      };

      await postJsonStream(modelData.endpoint, payload, onChunk, modelData.apiKey);

      // Log the complete streamed response
      log.logResponse('Streaming Final Response (Argo)', fullResponse, model);

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

