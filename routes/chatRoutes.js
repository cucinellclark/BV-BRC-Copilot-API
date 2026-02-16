// routes/chatRoutes.js

const express = require('express');
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
  rateConversation,
  rateMessage,
  getSessionFilesPaginated,
  getSessionStorageSize
} = require('../services/dbUtils');
const authenticate = require('../middleware/auth');
const promptManager = require('../prompts');
const { createLogger } = require('../services/logger');
const { addAgentJob, getJobStatus, getQueueStats, registerStreamCallback, abortJob } = require('../services/queueService');
const { writeSseEvent } = require('../services/sseUtils');
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
    try {
        const { query, rag_db, user_id, model, num_docs, session_id } = req.body;
        const response = await ChatService.handleRagRequest({ query, rag_db, num_docs, user_id, model, session_id });
        res.status(200).json(response);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
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
            return res.status(200).json({
                messages,
                workflow_ids: workflowIds,
                workflow_grid: workflowGrid
            });
        }

        const [sessionFiles, totalSize] = await Promise.all([
            getSessionFilesPaginated(session_id, limit, offset),
            getSessionStorageSize(session_id)
        ]);

        res.status(200).json({
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
        });
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
