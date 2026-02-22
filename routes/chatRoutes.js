// routes/chatRoutes.js

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { connectToDatabase } = require('../database');
const ChatService = require('../services/chatService');
const AgentOrchestrator = require('../services/agentOrchestrator');
const {
  getModelData,
  getChatSession,
  getSessionMessages,
  getSessionTitle,
  getUserSessions,
  updateSessionTitle,
  deleteSession,
  getUserPrompts,
  saveUserPrompt,
  registerChatSession,
  addWorkflowIdToSession,
  rateConversation,
  rateMessage,
  getSessionFilesPaginated,
  getSessionStorageSize,
  getUserWorkflowIds,
  searchRagChunkReferences
} = require('../services/dbUtils');
const authenticate = require('../middleware/auth');
const promptManager = require('../prompts');
const { createLogger } = require('../services/logger');
const { addAgentJob, getJobStatus, getQueueStats, registerStreamCallback, abortJob } = require('../services/queueService');
const { addRagJob, getRagJobStatus, getRagQueueStats, registerRagStreamCallback, abortRagJob } = require('../services/ragQueueService');
const { writeSseEvent } = require('../services/sseUtils');
const { executeMcpTool, isReplayableTool } = require('../services/mcp/mcpExecutor');
const config = require('../config.json');
const router = express.Router();

function parseBooleanFlag(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.toLowerCase().trim();
        if (['true', '1', 'yes'].includes(normalized)) return true;
        if (['false', '0', 'no'].includes(normalized)) return false;
    }
    return defaultValue;
}

function parseRagRequestPayload(body = {}) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const user_id = typeof body.user_id === 'string' ? body.user_id.trim() : body.user_id;
    const session_id = typeof body.session_id === 'string' ? body.session_id.trim() : body.session_id;
    const rag_db = body.rag_db || body.database_name || body.db_name;
    const parsedNumDocs = Number.parseInt(body.num_docs, 10);
    const num_docs = Number.isInteger(parsedNumDocs) && parsedNumDocs > 0 ? parsedNumDocs : null;
    const save_chat = parseBooleanFlag(body.save_chat, true);

    return {
        query,
        model,
        user_id,
        session_id,
        rag_db,
        num_docs,
        save_chat
    };
}

function buildGridEnvelope(entityType, opts = {}) {
    return {
        schema_version: '1.0',
        entity_type: entityType,
        source: opts.source || 'bvbrc-copilot-api',
        result_type: opts.resultType || 'list_result',
        capabilities: {
            selectable: opts.selectable !== false,
            multi_select: opts.multiSelect !== false,
            sortable: opts.sortable !== false
        },
        pagination: opts.pagination || null,
        sort: opts.sort || null,
        columns: Array.isArray(opts.columns) ? opts.columns : [],
        items: Array.isArray(opts.items) ? opts.items : []
    };
}

function mapWorkflowIdsToGridRows(workflowIds) {
    if (!Array.isArray(workflowIds)) {
        return [];
    }
    return workflowIds
        .filter((workflowId) => typeof workflowId === 'string' && workflowId.trim().length > 0)
        .map((workflowId) => ({
            id: workflowId,
            workflow_id: workflowId
        }));
}

function normalizeWorkflowStatus(rawStatus) {
    const value = String(rawStatus || '').toLowerCase();
    if (value === 'planned' || value === 'queued' || value === 'init' || value === 'pending') return 'pending';
    if (value === 'in-progress' || value === 'running') return 'running';
    if (value === 'completed' || value === 'complete' || value === 'success' || value === 'succeeded') return 'completed';
    if (value === 'failed' || value === 'error' || value === 'cancelled' || value === 'canceled') return 'failed';
    return value || 'unknown';
}

function workflowSortKey(workflow) {
    const ts = workflow && (workflow.submitted_at || workflow.created_at || workflow.updated_at);
    const parsed = Date.parse(ts || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeWorkflowRecord(workflow, workflowId) {
    const id = (workflow && (workflow.workflow_id || workflow.id)) || workflowId;
    const workflowName = (workflow && (workflow.workflow_name || workflow.name)) || 'Workflow';
    const rawStatus = workflow && workflow.status ? workflow.status : 'unknown';
    const status = normalizeWorkflowStatus(rawStatus);
    const submittedAt = (workflow && (workflow.submitted_at || workflow.created_at)) || null;
    const completedAt = (workflow && workflow.completed_at) || null;
    const stepCount = (workflow && Array.isArray(workflow.steps)) ? workflow.steps.length :
        ((workflow && typeof workflow.step_count === 'number') ? workflow.step_count : null);

    return {
        id: String(id),
        workflow_id: String(id),
        workflow_name: workflowName,
        status,
        raw_status: rawStatus,
        submitted_at: submittedAt,
        completed_at: completedAt,
        step_count: stepCount
    };
}

async function fetchWorkflowDetail(workflowBaseUrl, workflowId, authHeader) {
    const headers = { Accept: 'application/json' };
    if (authHeader) {
        headers.Authorization = authHeader;
    }
    const response = await axios.get(`${workflowBaseUrl}/workflows/${encodeURIComponent(workflowId)}`, {
        headers,
        timeout: 15000
    });
    return response && response.data ? response.data : null;
}

async function getUserWorkflowsWithDetail(userId, authHeader) {
    const workflowIds = await getUserWorkflowIds(userId);
    const workflowBaseUrl = process.env.WORKFLOW_URL || config.workflow_url || 'https://dev-7.bv-brc.org/api/v1';

    const workflows = await Promise.all(workflowIds.map(async (workflowId) => {
        try {
            const detail = await fetchWorkflowDetail(workflowBaseUrl, workflowId, authHeader);
            return normalizeWorkflowRecord(detail, workflowId);
        } catch (error) {
            return normalizeWorkflowRecord({
                workflow_id: workflowId,
                workflow_name: 'Unavailable',
                status: 'error'
            }, workflowId);
        }
    }));

    workflows.sort((a, b) => workflowSortKey(b) - workflowSortKey(a));
    return workflows;
}

// ========== MAIN CHAT ROUTES ==========
router.post('/copilot', authenticate, async (req, res) => {
    const logger = createLogger('CopilotRoute', req.body.session_id);

    try {
        logger.info('Copilot request received', {
            user_id: req.body.user_id,
            model: req.body.model,
            stream: req.body.stream,
            has_rag: !!req.body.rag_db
        });

        if (req.body.stream === true) {
            // -------- Streaming (SSE) path --------
            logger.debug('Using streaming response');
            res.set({
                // Headers required for proper SSE behaviour and to disable proxy buffering
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no' // Prevent Nginx (and similar) from buffering the stream
            });
            // Immediately flush the headers so the client is aware it's an SSE stream
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            await ChatService.handleCopilotStreamRequest(req.body, res);
            // The stream handler is responsible for ending the response
            return;
        }

        // -------- Standard JSON path --------
        logger.debug('Using standard JSON response');
        const { query, model, session_id, user_id, system_prompt, save_chat = true, include_history = true, rag_db = null, num_docs = null, image = null, enhanced_prompt = null } = req.body;
        const response = await ChatService.handleCopilotRequest({ query, model, session_id, user_id, system_prompt, save_chat, include_history, rag_db, num_docs, image, enhanced_prompt });

        logger.info('Copilot request completed successfully');
        res.status(200).json(response);
    } catch (error) {
        logger.error('Copilot request failed', {
            error: error.message,
            stack: error.stack
        });

        // If this was a streaming request, send error over SSE, else JSON
        if (req.body.stream === true) {
            writeSseEvent(res, 'error', { message: 'Internal server error', error: error.message });
            res.end();
        } else {
            res.status(500).json({ message: 'Internal server error', error });
        }
    }
});

// ========== AGENT COPILOT ROUTE (QUEUED WITH STREAMING) ==========
router.post('/copilot-agent', authenticate, async (req, res) => {
    const logger = createLogger('AgentRoute', req.body.session_id);

    try {
        const {
            query,
            model,
            session_id,
            user_id,
            system_prompt = '',
            save_chat = true,
            include_history = true,
            auth_token = null,
            stream = true,  // Default to streaming
            workspace_items = null,
            selected_jobs = null,
            selected_workflows = null,
            images = null
        } = req.body;

        // Validate required fields
        if (!query || !model || !user_id) {
            logger.warn('Missing required fields', {
                has_query: !!query,
                has_model: !!model,
                has_user_id: !!user_id
            });
            return res.status(400).json({
                message: 'Missing required fields',
                required: ['query', 'model', 'user_id']
            });
        }

        const max_iterations = config.agent?.max_iterations || 3;

        logger.info('Agent request received', {
            query_preview: query.substring(0, 100),
            model,
            session_id,
            user_id,
            save_chat,
            max_iterations,
            streaming: stream,
            has_workspace_items: !!workspace_items,
            workspace_items_count: workspace_items ? workspace_items.length : 0,
            has_selected_jobs: !!selected_jobs,
            selected_jobs_count: Array.isArray(selected_jobs) ? selected_jobs.length : 0,
            has_selected_workflows: !!selected_workflows,
            selected_workflows_count: Array.isArray(selected_workflows) ? selected_workflows.length : 0,
            has_images: Array.isArray(images) && images.length > 0,
            images_count: Array.isArray(images) ? images.length : 0
        });

        // Log workspace items if present
        if (workspace_items && Array.isArray(workspace_items) && workspace_items.length > 0) {
            logger.info('Workspace items received', {
                count: workspace_items.length,
                items: workspace_items.map(item => ({
                    type: item.type,
                    path: item.path,
                    name: item.name
                }))
            });
        }

        console.log('[ROUTE DEBUG] Stream parameter value:', stream, 'type:', typeof stream);

        if (stream) {
            // ========== STREAMING PATH ==========
            console.log('[ROUTE DEBUG] Entering streaming path');
            logger.debug('Using streaming response with queue');

            // Set SSE headers
            res.set({
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            // Flush headers immediately
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            console.log('[ROUTE DEBUG] SSE headers set and flushed');

            // Track if connection is still open
            let contentChunkCount = 0;
            let callbackInvocations = 0;
            let heartbeatInterval = null;
            console.log('[ROUTE DEBUG] Initial state - res.writableEnded:', res.writableEnded, 'res.destroyed:', res.destroyed);

            // Handle client disconnect (for cleanup only)
            req.on('close', () => {
                console.log('[ROUTE DEBUG] req.on(close) fired. Content chunks sent:', contentChunkCount, 'callback invocations:', callbackInvocations);
                logger.info('Client disconnected from stream', { session_id });
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
                // Job continues in background, result saved to DB
            });

            // Create streaming callback
            const streamCallback = (eventType, data) => {
                callbackInvocations++;

                // Only check response object state, not req events (which can be unreliable for SSE)
                if (res.writableEnded || res.destroyed) {
                    // Only log non-content events to reduce noise
                    if (eventType !== 'final_response' && eventType !== 'content') {
                        console.log('[ROUTE DEBUG] Response ended or destroyed, skipping write for event:', eventType);
                    }
                    return; // Connection closed, stop trying to write
                }

                try {
                    // Write SSE event
                    if (eventType === 'final_response' || eventType === 'content') {
                        contentChunkCount++;
                    } else {
                        console.log('[ROUTE DEBUG] Writing SSE event to response:', eventType);
                    }
                    writeSseEvent(res, eventType, data);

                    // Close stream on terminal events
                    if (eventType === 'done' || eventType === 'error' || eventType === 'cancelled') {
                        console.log('[ROUTE DEBUG] Stream ending. Total content chunks sent:', contentChunkCount);
                        res.end();
                    }
                } catch (error) {
                    logger.error('Failed to write to stream', {
                        error: error.message,
                        eventType
                    });
                    // Stream will be closed naturally, no need to track state
                }
            };

            // Send initial connection confirmation
            res.write(': connected\n\n');
            if (typeof res.flush === 'function') {
                res.flush();
            }
            console.log('[ROUTE DEBUG] Initial connection confirmation sent');

            // Add job to queue with streaming callback
            console.log('[ROUTE DEBUG] About to add job to queue');
            const job = await addAgentJob({
                query,
                model,
                session_id,
                user_id,
                system_prompt,
                save_chat,
                include_history,
                max_iterations,
                auth_token,
                workspace_items,
                selected_jobs,
                selected_workflows,
                images
            }, {
                streamCallback
            });

            console.log('[ROUTE DEBUG] Job added to queue, jobId:', job.id);
            logger.info('Streaming job queued', {
                jobId: job.id,
                session_id,
                user_id
            });

            // Set up heartbeat to keep connection alive
            heartbeatInterval = setInterval(() => {
                if (res.writableEnded || res.destroyed) {
                    clearInterval(heartbeatInterval);
                    return;
                }

                try {
                    res.write(': heartbeat\n\n');
                    if (typeof res.flush === 'function') {
                        res.flush();
                    }
                } catch (error) {
                    console.log('[ROUTE DEBUG] Heartbeat write failed:', error.message);
                    clearInterval(heartbeatInterval);
                }
            }, 15000); // Every 15 seconds

            // Note: Don't call res.end() here - stream stays open
            // The streamCallback will call res.end() when job completes

        } else {
            // ========== NON-STREAMING PATH (ORIGINAL) ==========
            console.log('[ROUTE DEBUG] Entering NON-streaming path (stream is false or undefined)');
            logger.debug('Using non-streaming response with queue');

            const job = await addAgentJob({
                query,
                model,
                session_id,
                user_id,
                system_prompt,
                save_chat,
                include_history,
                max_iterations,
                auth_token,
                workspace_items,
                selected_jobs,
                selected_workflows,
                images
            });

            logger.info('Agent job queued successfully', {
                jobId: job.id,
                session_id,
                user_id
            });

            res.status(202).json({
                message: 'Agent job queued successfully',
                job_id: job.id,
                session_id: session_id,
                status_endpoint: `/copilot-api/chatbrc/job/${job.id}/status`,
                poll_interval_ms: config.agent?.job_poll_interval || 1000
            });
        }

    } catch (error) {
        logger.error('Failed to queue agent job', {
            error: error.message,
            stack: error.stack
        });

        if (req.body.stream !== false && res.headersSent) {
            // Streaming: Send error event
            try {
                writeSseEvent(res, 'error', {
                    message: 'Failed to queue job',
                    error: error.message
                });
                res.end();
            } catch (e) {
                // Connection already closed
            }
        } else {
            // Non-streaming: Return 500
            res.status(500).json({
                message: 'Failed to queue agent job',
                error: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    }
});

router.post('/mcp/replay-tool-call', authenticate, async (req, res) => {
    const logger = createLogger('McpReplayRoute', req.body && req.body.session_id);
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader) {
            return res.status(401).json({
                message: 'Missing Authorization header'
            });
        }

        const toolCall = req.body && typeof req.body.tool_call === 'object' ? req.body.tool_call : {};
        const toolId = req.body.tool_id || toolCall.action;
        const parameters = req.body.parameters || toolCall.arguments || {};
        const replayPageSize = req.body.page_size;
        const sessionId = req.body.session_id || null;
        const userId = req.user || req.body.user_id || null;

        if (!toolId || typeof toolId !== 'string') {
            return res.status(400).json({
                message: 'tool_id (or tool_call.action) is required'
            });
        }
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
            return res.status(400).json({
                message: 'parameters (or tool_call.arguments) must be an object'
            });
        }
        if (replayPageSize !== undefined) {
            const parsedPageSize = Number.parseInt(replayPageSize, 10);
            if (!Number.isFinite(parsedPageSize) || parsedPageSize <= 0) {
                return res.status(400).json({
                    message: 'page_size must be a positive integer'
                });
            }
        }

        if (!isReplayableTool(toolId)) {
            return res.status(403).json({
                message: `Tool is not replayable: ${toolId}`,
                tool_id: toolId
            });
        }

        const executionContext = {
            session_id: sessionId,
            user_id: userId,
            auth_token: authHeader,
            authToken: authHeader,
            replay_page_size: replayPageSize
        };

        logger.info('Replaying MCP tool call', {
            tool_id: toolId,
            session_id: sessionId,
            user_id: userId,
            parameter_keys: Object.keys(parameters || {})
        });

        const result = await executeMcpTool(
            toolId,
            parameters,
            authHeader,
            executionContext,
            logger
        );

        const normalizedCall = {
            id: uuidv4(),
            run_id: null,
            iteration: null,
            action: toolId,
            sequence: 1,
            arguments: parameters,
            replay: (result && typeof result.replay === 'object') ? result.replay : null,
            status: (result && result.error) ? 'error' : 'success',
            result_ref: {
                type: result && result.type === 'file_reference' ? 'file_reference' : 'inline_result'
            }
        };

        return res.status(200).json({
            message: 'Tool replay executed successfully',
            tool_id: toolId,
            tool_call: normalizedCall,
            result
        });
    } catch (error) {
        logger.error('Tool replay failed', {
            error: error.message,
            stack: error.stack
        });
        return res.status(500).json({
            message: 'Tool replay failed',
            error: error.message
        });
    }
});

// ========== JOB STATUS ROUTE ==========
router.get('/job/:jobId/status', authenticate, async (req, res) => {
    const logger = createLogger('JobStatus');

    try {
        const { jobId } = req.params;

        logger.info('Job status request', { jobId });

        const jobStatus = await getJobStatus(jobId);

        if (!jobStatus.found) {
            logger.warn('Job not found', { jobId });
            return res.status(404).json({
                message: 'Job not found',
                job_id: jobId
            });
        }

        logger.info('Job status retrieved', {
            jobId,
            status: jobStatus.status,
            progress: jobStatus.progress?.percentage || 0
        });

        res.status(200).json(jobStatus);

    } catch (error) {
        logger.error('Failed to get job status', {
            error: error.message,
            jobId: req.params.jobId
        });

        res.status(500).json({
            message: 'Failed to retrieve job status',
            error: error.message
        });
    }
});

// ========== QUEUE STATS ROUTE (for monitoring) ==========
router.get('/queue/stats', authenticate, async (req, res) => {
    const logger = createLogger('QueueStats');

    try {
        logger.info('Queue stats request');

        const stats = await getQueueStats();

        res.status(200).json({
            message: 'Queue statistics',
            timestamp: new Date().toISOString(),
            stats
        });

    } catch (error) {
        logger.error('Failed to get queue stats', {
            error: error.message
        });

        res.status(500).json({
            message: 'Failed to retrieve queue statistics',
            error: error.message
        });
    }
});

// ========== JOB ABORT ROUTE ==========
router.post('/job/:jobId/abort', authenticate, async (req, res) => {
    const logger = createLogger('JobAbort');

    try {
        const { jobId } = req.params;

        logger.info('Job abort request', { jobId });

        const result = await abortJob(jobId);

        if (!result.found) {
            return res.status(404).json({
                message: 'Job not found',
                job_id: jobId
            });
        }

        if (!result.success) {
            return res.status(409).json({
                message: result.message,
                job_id: jobId,
                previous_state: result.previousState,
                note: result.note
            });
        }

        if (result.accepted) {
            return res.status(202).json({
                message: result.message,
                job_id: jobId,
                previous_state: result.previousState,
                note: result.note
            });
        }

        return res.status(200).json({
            message: result.message,
            job_id: jobId,
            previous_state: result.previousState
        });
    } catch (error) {
        logger.error('Failed to abort job', {
            error: error.message,
            jobId: req.params.jobId
        });

        return res.status(500).json({
            message: 'Failed to abort job',
            error: error.message
        });
    }
});

// ========== STREAM RECONNECTION ENDPOINT ==========
router.get('/job/:jobId/stream', authenticate, async (req, res) => {
    const logger = createLogger('JobStream');
    const { jobId } = req.params;

    try {
        logger.info('Stream reconnection requested', { jobId });

        // Set SSE headers
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        res.flushHeaders();
        res.write(': connected\n\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }

        // Get job status
        const jobStatus = await getJobStatus(jobId);

        if (!jobStatus.found) {
            writeSseEvent(res, 'error', { message: 'Job not found' });
            res.end();
            return;
        }

        // Check job state
        const state = jobStatus.status;

        if (state === 'completed') {
            // Job already done
            logger.info('Job already completed', { jobId });

            writeSseEvent(res, 'started', {
                job_id: jobId,
                message: 'Job already completed'
            });

            writeSseEvent(res, 'done', {
                job_id: jobId,
                session_id: jobStatus.data.session_id,
                message: 'Fetch result from /get-session-messages',
                iterations: 0,
                tools_used: [],
                duration_seconds: 0
            });

            res.end();
            return;
        }

        if (state === 'failed') {
            // Job failed
            writeSseEvent(res, 'error', {
                job_id: jobId,
                error: jobStatus.error?.message || 'Job failed'
            });
            res.end();
            return;
        }

        // Job is waiting or active, attach new stream callback
        logger.info('Attaching new stream to active/waiting job', { jobId, state });

        const streamCallback = (eventType, data) => {
            // Only check response object state, not req events
            if (res.writableEnded || res.destroyed) return;

            try {
                writeSseEvent(res, eventType, data);

                if (eventType === 'done' || eventType === 'error' || eventType === 'cancelled') {
                    res.end();
                }
            } catch (error) {
                logger.error('Stream write failed', { error: error.message });
            }
        };

        // Register the new callback
        registerStreamCallback(jobId, streamCallback);

        // Send current status
        writeSseEvent(res, state === 'active' ? 'started' : 'queued', {
            job_id: jobId,
            status: state,
            progress: jobStatus.progress,
            message: state === 'active' ? 'Processing' : 'Waiting in queue',
            session_id: jobStatus.data.session_id
        });

        // Heartbeat
        let heartbeatInterval = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                clearInterval(heartbeatInterval);
                return;
            }
            try {
                res.write(': heartbeat\n\n');
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            } catch (error) {
                clearInterval(heartbeatInterval);
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeatInterval);
            logger.info('Stream reconnection closed', { jobId });
        });

    } catch (error) {
        logger.error('Stream reconnection failed', {
            jobId,
            error: error.message
        });

        try {
            writeSseEvent(res, 'error', {
                message: 'Stream reconnection failed',
                error: error.message
            });
            res.end();
        } catch (e) {
            // Connection already closed
        }
    }
});

// ========== RAG QUEUE ROUTES ==========
router.get('/rag/job/:jobId/status', authenticate, async (req, res) => {
    const logger = createLogger('RagJobStatus');
    try {
        const { jobId } = req.params;
        const jobStatus = await getRagJobStatus(jobId);

        if (!jobStatus.found) {
            return res.status(404).json({
                message: 'RAG job not found',
                job_id: jobId
            });
        }

        return res.status(200).json(jobStatus);
    } catch (error) {
        logger.error('Failed to get RAG job status', {
            error: error.message,
            jobId: req.params.jobId
        });
        return res.status(500).json({
            message: 'Failed to retrieve RAG job status',
            error: error.message
        });
    }
});

router.get('/rag/queue/stats', authenticate, async (req, res) => {
    const logger = createLogger('RagQueueStats');
    try {
        const stats = await getRagQueueStats();
        return res.status(200).json({
            message: 'RAG queue statistics',
            timestamp: new Date().toISOString(),
            stats
        });
    } catch (error) {
        logger.error('Failed to get RAG queue stats', { error: error.message });
        return res.status(500).json({
            message: 'Failed to retrieve RAG queue statistics',
            error: error.message
        });
    }
});

router.post('/rag/job/:jobId/abort', authenticate, async (req, res) => {
    const logger = createLogger('RagJobAbort');
    try {
        const { jobId } = req.params;
        const result = await abortRagJob(jobId);

        if (!result.found) {
            return res.status(404).json({
                message: 'RAG job not found',
                job_id: jobId
            });
        }
        if (!result.success) {
            return res.status(409).json({
                message: result.message,
                job_id: jobId,
                previous_state: result.previousState
            });
        }
        return res.status(200).json({
            message: result.message,
            job_id: jobId,
            previous_state: result.previousState
        });
    } catch (error) {
        logger.error('Failed to abort RAG job', {
            error: error.message,
            jobId: req.params.jobId
        });
        return res.status(500).json({
            message: 'Failed to abort RAG job',
            error: error.message
        });
    }
});

router.get('/rag/job/:jobId/stream', authenticate, async (req, res) => {
    const logger = createLogger('RagJobStream');
    const { jobId } = req.params;

    try {
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write(': connected\n\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }

        const jobStatus = await getRagJobStatus(jobId);
        if (!jobStatus.found) {
            writeSseEvent(res, 'error', { message: 'RAG job not found' });
            res.end();
            return;
        }

        const state = jobStatus.status;
        if (state === 'completed') {
            writeSseEvent(res, 'final_response', {
                job_id: jobId,
                response: jobStatus.result?.response || null
            });
            writeSseEvent(res, 'done', {
                job_id: jobId,
                session_id: jobStatus.data?.session_id || null
            });
            res.end();
            return;
        }
        if (state === 'failed' || state === 'cancelled') {
            writeSseEvent(res, 'error', {
                job_id: jobId,
                error: jobStatus.error?.message || `RAG job ${state}`
            });
            res.end();
            return;
        }

        const streamCallback = (eventType, data) => {
            if (res.writableEnded || res.destroyed) return;
            try {
                writeSseEvent(res, eventType, data);
                if (eventType === 'done' || eventType === 'error' || eventType === 'cancelled') {
                    res.end();
                }
            } catch (streamError) {
                logger.error('RAG stream write failed', { error: streamError.message });
            }
        };

        registerRagStreamCallback(jobId, streamCallback);
        writeSseEvent(res, state === 'active' ? 'started' : 'queued', {
            job_id: jobId,
            status: state,
            progress: jobStatus.progress,
            message: state === 'active' ? 'Processing' : 'Waiting in queue',
            session_id: jobStatus.data?.session_id || null
        });

        let heartbeatInterval = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                clearInterval(heartbeatInterval);
                return;
            }
            try {
                res.write(': heartbeat\n\n');
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            } catch (_error) {
                clearInterval(heartbeatInterval);
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeatInterval);
        });
    } catch (error) {
        logger.error('RAG stream reconnection failed', {
            jobId,
            error: error.message
        });
        try {
            writeSseEvent(res, 'error', {
                message: 'RAG stream reconnection failed',
                error: error.message
            });
            res.end();
        } catch (_e) {
            // Connection already closed
        }
    }
});

router.post('/chat', authenticate, async (req, res) => {
    const logger = createLogger('ChatRoute', req.body.session_id);

    try {
        logger.info('Chat request received', {
            user_id: req.body.user_id,
            model: req.body.model
        });

        const { query, model, session_id, user_id, system_prompt, save_chat = true } = req.body;
        const response = await ChatService.handleChatRequest({
            query,
            model,
            session_id,
            user_id,
            system_prompt,
            save_chat
        });

        logger.info('Chat request completed successfully');
        res.status(200).json(response);
    } catch (error) {
        logger.error('Chat request failed', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ message: 'Internal server error', error });
    }
});

router.post('/rag', authenticate, async (req, res) => {
    const logger = createLogger('RagRoute', req.body.session_id);

    try {
        const {
            query,
            model,
            user_id,
            session_id,
            rag_db,
            num_docs,
            save_chat
        } = parseRagRequestPayload(req.body);

        if (!query || !model || !user_id || !rag_db) {
            return res.status(400).json({
                message: 'Missing required fields',
                required: ['query', 'model', 'user_id', 'rag_db'],
                accepted_rag_db_fields: ['rag_db', 'database_name', 'db_name']
            });
        }

        logger.info('RAG request received', {
            user_id,
            model,
            session_id,
            rag_db,
            num_docs
        });

        const job = await addRagJob({
            query,
            rag_db,
            num_docs,
            user_id,
            model,
            session_id,
            save_chat
        });

        logger.info('RAG job queued successfully', {
            job_id: job.id,
            session_id,
            rag_db
        });

        return res.status(202).json({
            message: 'RAG job queued successfully',
            job_id: job.id,
            session_id,
            status_endpoint: `/copilot-api/chatbrc/rag/job/${job.id}/status`,
            stream_endpoint: `/copilot-api/chatbrc/rag/job/${job.id}/stream`,
            poll_interval_ms: config.agent?.job_poll_interval || 1000
        });
    } catch (error) {
        logger.error('RAG request failed', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

router.post('/rag/stream', authenticate, async (req, res) => {
    const logger = createLogger('RagStreamRoute', req.body.session_id);

    try {
        const {
            query,
            model,
            user_id,
            session_id,
            rag_db,
            num_docs,
            save_chat
        } = parseRagRequestPayload(req.body);

        if (!query || !model || !user_id || !rag_db) {
            return res.status(400).json({
                message: 'Missing required fields',
                required: ['query', 'model', 'user_id', 'rag_db'],
                accepted_rag_db_fields: ['rag_db', 'database_name', 'db_name']
            });
        }

        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        const streamCallback = (eventType, data) => {
            if (res.writableEnded || res.destroyed) return;
            try {
                writeSseEvent(res, eventType, data);
                if (eventType === 'done' || eventType === 'error' || eventType === 'cancelled') {
                    res.end();
                }
            } catch (_error) {
                // Connection already closed
            }
        };

        res.write(': connected\n\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }

        const job = await addRagJob({
            query,
            rag_db,
            num_docs,
            user_id,
            model,
            session_id,
            save_chat
        }, {
            streamCallback
        });

        logger.info('Streaming RAG job queued', {
            jobId: job.id,
            session_id,
            user_id
        });

        let heartbeatInterval = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                clearInterval(heartbeatInterval);
                return;
            }
            try {
                res.write(': heartbeat\n\n');
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            } catch (_error) {
                clearInterval(heartbeatInterval);
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeatInterval);
        });
    } catch (error) {
        logger.error('Failed to queue streaming RAG job', {
            error: error.message,
            stack: error.stack
        });

        if (res.headersSent) {
            try {
                writeSseEvent(res, 'error', {
                    message: 'Failed to queue streaming RAG job',
                    error: error.message
                });
                res.end();
            } catch (_e) {
                // Connection already closed
            }
        } else {
            res.status(500).json({
                message: 'Failed to queue streaming RAG job',
                error: error.message
            });
        }
    }
});

router.post('/rag-distllm', authenticate, async (req, res) => {
    try {
        const { query, rag_db, user_id, model, num_docs, session_id } = req.body;
        const response = await ChatService.handleRagRequestDistllm({ query, rag_db, user_id, model, num_docs, session_id });
        res.status(200).json(response);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

router.post('/chat-image', authenticate, async (req, res) => {
    try {
        const { query, model, session_id, user_id, system_prompt, save_chat = true, image } = req.body;
        // const image = req.file ? req.file.buffer.toString('base64') : null;
        const response = await ChatService.handleChatImageRequest({
            query,
            model,
            session_id,
            user_id,
            image,
            system_prompt,
            save_chat
        });
        res.status(200).json(response);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

router.post('/demo', authenticate, async (req, res) => {
    try {
        const { text, rag_flag } = req.body;
        const lambdaResponse = await ChatService.handleLambdaDemo(text, rag_flag);
        res.status(200).json({ content: lambdaResponse });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Internal server error in demo', error });
    }
});

// ========== SESSION ROUTES ==========
router.get('/start-chat', authenticate, (req, res) => {
    const sessionId = uuidv4();
    res.status(200).json({ message: 'created session id', session_id: sessionId });
});

router.post('/register-session', authenticate, async (req, res) => {
    try {
        const { session_id, user_id, title } = req.body || {};
        if (!session_id || !user_id) {
            return res.status(400).json({ message: 'session_id and user_id are required' });
        }

        const registration = await registerChatSession(session_id, user_id, title || 'New Chat');
        return res.status(200).json({
            status: 'ok',
            session_id,
            created: registration.created === true
        });
    } catch (error) {
        console.error('Error registering chat session:', error);
        return res.status(500).json({ message: 'Failed to register session', error: error.message });
    }
});

router.post('/add-workflow-to-session', authenticate, async (req, res) => {
    try {
        const { session_id, workflow_id, user_id } = req.body || {};
        if (!session_id || !workflow_id || !user_id) {
            return res.status(400).json({ message: 'session_id, workflow_id, and user_id are required' });
        }

        const session = await getChatSession(session_id);
        if (!session) {
            return res.status(404).json({ message: 'Session not found' });
        }
        if (session.user_id && session.user_id !== user_id) {
            return res.status(403).json({ message: 'Not authorized to modify this session' });
        }

        await addWorkflowIdToSession(session_id, workflow_id);
        return res.status(200).json({
            status: 'ok',
            session_id,
            workflow_id
        });
    } catch (error) {
        console.error('Error adding workflow to session:', error);
        return res.status(500).json({ message: 'Failed to add workflow to session', error: error.message });
    }
});

router.get('/rag-chunk-search', authenticate, async (req, res) => {
    try {
        const chunk_id = typeof req.query.chunk_id === 'string' ? req.query.chunk_id.trim() : '';
        const rag_db = typeof req.query.rag_db === 'string'
            ? req.query.rag_db.trim()
            : (typeof req.query.database_name === 'string' ? req.query.database_name.trim() : '');
        const rag_api_name = typeof req.query.rag_api_name === 'string' ? req.query.rag_api_name.trim() : '';
        const doc_id = typeof req.query.doc_id === 'string' ? req.query.doc_id.trim() : '';
        const source_id = typeof req.query.source_id === 'string' ? req.query.source_id.trim() : '';
        const session_id = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
        const user_id = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
        const message_id = typeof req.query.message_id === 'string' ? req.query.message_id.trim() : '';
        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 200) : 50;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;
        const include_content = parseBooleanFlag(req.query.include_content, false);

        if (!chunk_id && !rag_db && !rag_api_name && !doc_id && !source_id && !session_id && !user_id && !message_id) {
            return res.status(400).json({
                message: 'At least one filter is required',
                accepted_filters: ['chunk_id', 'rag_db', 'rag_api_name', 'doc_id', 'source_id', 'session_id', 'user_id', 'message_id']
            });
        }

        const result = await searchRagChunkReferences({
            chunk_id: chunk_id || undefined,
            rag_db: rag_db || undefined,
            rag_api_name: rag_api_name || undefined,
            doc_id: doc_id || undefined,
            source_id: source_id || undefined,
            session_id: session_id || undefined,
            user_id: user_id || undefined,
            message_id: message_id || undefined,
            limit,
            offset,
            include_content
        });

        return res.status(200).json({
            filters: {
                chunk_id: chunk_id || null,
                rag_db: rag_db || null,
                rag_api_name: rag_api_name || null,
                doc_id: doc_id || null,
                source_id: source_id || null,
                session_id: session_id || null,
                user_id: user_id || null,
                message_id: message_id || null
            },
            total: result.total,
            limit: result.limit,
            offset: result.offset,
            has_more: result.has_more,
            items: result.items
        });
    } catch (error) {
        console.error('Error searching RAG chunk references:', error);
        return res.status(500).json({ message: 'Failed to search RAG chunk references', error: error.message });
    }
});

router.get('/get-session-messages', authenticate, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        const user_id = req.query.user_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }

        const session = await getChatSession(session_id);
        if (user_id && session && session.user_id && session.user_id !== user_id) {
            return res.status(403).json({ message: 'Not authorized to access this session' });
        }
        const workflowIds = session?.workflow_ids || [];

        const includeFiles = parseBooleanFlag(req.query.include_files, false);
        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 20;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;

        const messages = await getSessionMessages(session_id);

        const workflowRows = mapWorkflowIdsToGridRows(workflowIds);
        const workflowGrid = buildGridEnvelope('workflow', {
            source: 'bvbrc-copilot-session',
            resultType: 'list_result',
            selectable: true,
            multiSelect: true,
            sortable: false,
            columns: [
                { key: 'workflow_id', label: 'Workflow ID', sortable: false }
            ],
            items: workflowRows
        });

        if (!includeFiles) {
            const payload = {
                messages,
                workflow_ids: workflowIds,
                workflow_grid: workflowGrid
            };
            return res.status(200).json(payload);
        }

        const [sessionFiles, totalSize] = await Promise.all([
            getSessionFilesPaginated(session_id, limit, offset),
            getSessionStorageSize(session_id)
        ]);

        const payload = {
            messages,
            workflow_ids: workflowIds,
            workflow_grid: workflowGrid,
            session_files: sessionFiles.files,
            session_files_pagination: {
                total: sessionFiles.total,
                limit: sessionFiles.limit,
                offset: sessionFiles.offset,
                has_more: sessionFiles.has_more
            },
            session_file_summary: {
                total_files: sessionFiles.total,
                total_size_bytes: totalSize
            }
        };
        res.status(200).json(payload);
    } catch (error) {
        console.error('Error retrieving session messages:', error);
        res.status(500).json({ message: 'Failed to retrieve session messages', error: error.message });
    }
});

router.get('/get-session-files', authenticate, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        const user_id = req.query.user_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }

        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 20;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;

        const session = await getChatSession(session_id);
        if (user_id && session && session.user_id && session.user_id !== user_id) {
            return res.status(403).json({ message: 'Not authorized to access this session' });
        }

        const [sessionFiles, totalSize] = await Promise.all([
            getSessionFilesPaginated(session_id, limit, offset),
            getSessionStorageSize(session_id)
        ]);

        const fileGrid = buildGridEnvelope('session_file', {
            source: 'bvbrc-copilot-session',
            resultType: 'list_result',
            selectable: true,
            multiSelect: true,
            sortable: true,
            pagination: {
                total: sessionFiles.total,
                limit: sessionFiles.limit,
                offset: sessionFiles.offset,
                has_more: sessionFiles.has_more
            },
            columns: [
                { key: 'file_name', label: 'File', sortable: true },
                { key: 'tool_id', label: 'Tool', sortable: true },
                { key: 'created_at', label: 'Created', sortable: true },
                { key: 'size_bytes', label: 'Size (bytes)', sortable: true },
                { key: 'record_count', label: 'Records', sortable: true },
                { key: 'data_type', label: 'Type', sortable: true },
                { key: 'is_error', label: 'Error Output', sortable: true }
            ],
            items: sessionFiles.files
        });

        res.status(200).json({
            session_id,
            files: sessionFiles.files,
            pagination: {
                total: sessionFiles.total,
                limit: sessionFiles.limit,
                offset: sessionFiles.offset,
                has_more: sessionFiles.has_more
            },
            summary: {
                total_files: sessionFiles.total,
                total_size_bytes: totalSize
            },
            grid: fileGrid
        });
    } catch (error) {
        console.error('Error retrieving session files:', error);
        res.status(500).json({ message: 'Failed to retrieve session files', error: error.message });
    }
});

router.get('/get-session-title', authenticate, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }

        const title = await getSessionTitle(session_id);
        res.status(200).json({ title });
    } catch (error) {
        console.error('Error retrieving session title:', error);
        res.status(500).json({ message: 'Failed to retrieve session title', error: error.message });
    }
});

router.get('/get-all-sessions', authenticate, async (req, res) => {
    try {
        const user_id = req.query.user_id;
        if (!user_id) {
            return res.status(400).json({ message: 'user_id is required' });
        }

        // Parse pagination parameters
        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        let limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 20;
        let offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;

        const { sessions, total } = await getUserSessions(user_id, limit, offset);
        const has_more = offset + sessions.length < total;
        res.status(200).json({ sessions, total, has_more });
    } catch (error) {
        console.error('Error retrieving chat sessions:', error);
        res.status(500).json({ message: 'Failed to retrieve chat sessions', error: error.message });
    }
});

router.get('/get-user-workflows', authenticate, async (req, res) => {
    try {
        const user_id = req.query.user_id;
        if (!user_id) {
            return res.status(400).json({ message: 'user_id is required' });
        }

        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 1000) : 200;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;
        const statusFilter = req.query.status ? String(req.query.status).toLowerCase().trim() : '';

        const authHeader = req.headers ? req.headers.authorization : '';
        const allWorkflows = await getUserWorkflowsWithDetail(user_id, authHeader);
        const filtered = statusFilter
            ? allWorkflows.filter((workflow) => String(workflow.status).toLowerCase() === statusFilter)
            : allWorkflows;
        const rows = filtered.slice(offset, offset + limit);

        return res.status(200).json({
            user_id,
            workflows: rows,
            total: filtered.length,
            limit,
            offset,
            has_more: offset + rows.length < filtered.length
        });
    } catch (error) {
        console.error('Error retrieving user workflows:', error);
        return res.status(500).json({ message: 'Failed to retrieve user workflows', error: error.message });
    }
});

router.get('/get-user-workflow-summary', authenticate, async (req, res) => {
    try {
        const user_id = req.query.user_id;
        if (!user_id) {
            return res.status(400).json({ message: 'user_id is required' });
        }

        const authHeader = req.headers ? req.headers.authorization : '';
        const workflows = await getUserWorkflowsWithDetail(user_id, authHeader);

        const summary = {
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0
        };

        workflows.forEach((workflow) => {
            const key = workflow.status;
            if (Object.prototype.hasOwnProperty.call(summary, key)) {
                summary[key] += 1;
            }
        });

        return res.status(200).json({
            user_id,
            summary,
            total: workflows.length
        });
    } catch (error) {
        console.error('Error retrieving user workflow summary:', error);
        return res.status(500).json({ message: 'Failed to retrieve user workflow summary', error: error.message });
    }
});

router.post('/put-chat-entry', async (req, res) => {
    console.log('Inserting chat entry');
    console.log(req.body);
    // Implement insertion logic
});

router.post('/generate-title-from-messages', authenticate, async (req, res) => {
    try {
        const { model, messages, user_id } = req.body;
        const message_str = messages.map(msg => `message: ${msg}`).join('\n\n');
        const titlePrompt = promptManager.getChatPrompt('titleGeneration');
        const query = `${titlePrompt}\n\n${message_str}`;

        const modelData = await getModelData(model);
        const queryType = modelData['queryType'];
        let response;

        if (queryType === 'client') {
            const openai_client = ChatService.getOpenaiClient(modelData);
            const queryMsg = [{ role: 'user', content: query }];
            response = await ChatService.queryModel(openai_client, model, queryMsg);
        } else if (queryType === 'request') {
            response = await ChatService.queryRequest(modelData.endpoint, model, '', query);
        } else if (queryType === 'argo') {
            response = await ChatService.queryRequestArgo(modelData.endpoint, model, '', query);
        } else {
            return res.status(500).json({ message: 'Invalid query type', queryType });
        }

        res.status(200).json({ message: 'success', response });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

router.post('/update-session-title', authenticate, async (req, res) => {
    try {
        const { title, session_id, user_id } = req.body;
        const updateResult = await updateSessionTitle(session_id, user_id, title);

        if (updateResult.matchedCount === 0) {
            return res.status(404).json({ message: 'Session not found or user not authorized' });
        }

        res.status(200).json({ message: 'Session title updated successfully' });
    } catch (error) {
        console.error('Error updating session title:', error);
        res.status(500).json({ message: 'Failed to update session title', error: error.message });
    }
});

router.post('/delete-session', authenticate, async (req, res) => {
    try {
        const { session_id, user_id } = req.body;
        if (!session_id) {
            return res.status(400).json({ message: 'Session ID is required' });
        }

        const deleteResult = await deleteSession(session_id, user_id);

        if (deleteResult.deletedCount === 0) {
            return res.status(404).json({ message: 'Session not found' });
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({ message: 'Failed to delete session', error: error.message });
    }
});

router.get('/get-user-prompts', authenticate, async (req, res) => {
    try {
        const user_id = req.query.user_id;
        const prompts = await getUserPrompts(user_id);
        res.status(200).json({ prompts });
    } catch (error) {
        console.error('Error getting user prompts:', error);
        res.status(500).json({ message: 'Failed getting user prompts', error: error.message });
    }
});

router.post('/save-prompt', authenticate, async (req, res) => {
    try {
        const { name, text, user_id } = req.body;
        const updateResult = await saveUserPrompt(user_id, name, text);
        res.status(200).json({ update_result: updateResult, title: name, content: text });
    } catch (error) {
        console.error('Error saving user prompt:', error);
        res.status(500).json({ message: 'Failed saving user prompt', error: error.message });
    }
});

router.post('/rate-conversation', authenticate, async (req, res) => {
    try {
        const { session_id, user_id, rating } = req.body;

        // Validate required fields
        if (!session_id || !user_id || rating === undefined) {
            return res.status(400).json({
                message: 'session_id, user_id, and rating are required'
            });
        }

        // Validate rating value (assuming 1-5 scale)
        if (typeof rating !== 'number' || rating < 1 || rating > 5) {
            return res.status(400).json({
                message: 'Rating must be a number between 1 and 5'
            });
        }

        const result = await rateConversation(session_id, user_id, rating);

        res.status(200).json({
            message: 'Conversation rated successfully',
            session_id,
            rating
        });
    } catch (error) {
        console.error('Error rating conversation:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

router.post('/rate-message', authenticate, async (req, res) => {
    try {
        const { user_id, message_id, rating } = req.body;

        // Validate required fields
        if (!user_id || !message_id || rating === undefined) {
            return res.status(400).json({
                message: 'user_id, message_id, and rating are required'
            });
        }

        // Validate rating value: -1, 0, 1
        if (typeof rating !== 'number' || rating < -1 || rating > 1) {
            return res.status(400).json({
                message: 'Rating must be a number between -1 and 1'
            });
        }

        const result = await rateMessage(user_id, message_id, rating);

        res.status(200).json({
            message: 'Message rated successfully',
            user_id,
            message_id,
            rating
        });
    } catch (error) {
        console.error('Error rating message:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// ========== SIMPLIFIED CHAT ==========
router.post('/chat-only', authenticate, async (req, res) => {
    try {
        const { query, model, system_prompt } = req.body;
        if (!query || !model) {
            return res.status(400).json({ message: 'query and model are required' });
        }

        const response_json = await ChatService.handleChatQuery({ query, model, system_prompt });
        res.status(200).json({ message: 'success', response:response_json });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

// ========== Data Utils ==========
router.post('/get-path-state', authenticate, async (req, res) => {
    try {
        const { path } = req.body;
        const pathState = await ChatService.getPathState(path);
        res.status(200).json({ message: 'success', pathState });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});


module.exports = router;
