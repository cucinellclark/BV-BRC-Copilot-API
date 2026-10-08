// routes/chatRoutes.js

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { connectToDatabase } = require('../services/database');
const ChatService = require('../services/chatService');
// agentOrchestrator.js deleted — chat runs in-request via chatRunner.js
const {
  getModelData,
  getChatSession,
  getSessionMessages,
  getSessionTitle,
  getUserSessions,
  updateSessionTitle,
  setSessionExecutionMode,
  isValidExecutionMode,
  normalizeExecutionMode,
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
  getSessionIdForActiveJob
} = require('../services/dbUtils');
const { requireAuth, resolveUserId } = require('../middleware/auth');
const { requireSessionOwner, canAccessSession } = require('../middleware/sessionOwnership');
const promptManager = require('../prompts');
const { createLogger } = require('../services/logger');
// queueService.js — only import what's still needed (abort route uses setCancelFlag from chatRunner instead)
// ragQueueService.js deleted — RAG routes removed
const { writeSseEvent } = require('../services/sseUtils');
const { runChatTurn, setCancelFlag } = require('../services/chatRunner');
const config = require('../config.json');
const router = express.Router();

/**
 * Plan-mode guard for routes that run a plan step.
 *
 * Plan execution delegates to the service agent, which would submit jobs,
 * so the session must be in execute mode.  The Python tool gate would
 * refuse the submission anyway; this just fails fast with a clear code
 * the frontend can render.  Returns true when the caller may proceed.
 */
async function requireExecuteMode(res, session_id, logger) {
    const chatSession = session_id ? await getChatSession(session_id) : null;
    const mode = normalizeExecutionMode(chatSession && chatSession.execution_mode);
    if (mode !== 'execute') {
        logger.info('Plan step refused: session is in plan mode', { session_id });
        res.status(409).json({
            code: 'PLAN_MODE',
            execution_mode: mode,
            message: 'Switch this chat to Execute mode to run the plan.'
        });
        return false;
    }
    return true;
}

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

// parseRagRequestPayload removed — RAG routes deleted

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

// ========== AGENT COPILOT ROUTE (QUEUED WITH STREAMING) ==========
router.post('/copilot-agent', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('AgentRoute', req.body.session_id);

    try {
        const {
            query,
            model,
            session_id,
            system_prompt = '',
            save_chat = true,
            include_history = true,
            stream = true,  // Default to streaming
            workspace_items = null,
            selected_jobs = null,
            selected_workflows = null,
            images = null,
            image_attachments = null,
            files = null,
            pdfs = null,
            execution_mode = null,
            execute_once = false,
            target_agent = null,
            workflow_context = null
        } = req.body;

        // Validate and resolve user identity from the authenticated token
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        // Use the token from the validated Authorization header, not from the request body
        const auth_token = req.authToken || null;

        // Execution-mode write-through: the toggle persists via
        // /update-session-execution-mode, but a toggle-then-send can race
        // that request, so the send carries the mode too.  Persist it before
        // the turn; the orchestrator loop then reads it from the session.
        if (execution_mode !== null && execution_mode !== undefined) {
            if (!isValidExecutionMode(execution_mode)) {
                return res.status(400).json({ message: `Invalid execution_mode: ${execution_mode}` });
            }
            if (session_id && save_chat) {
                try {
                    await registerChatSession(session_id, user_id);
                    await setSessionExecutionMode(session_id, user_id, execution_mode);
                } catch (err) {
                    logger.warn('Failed to persist execution_mode before turn', { error: err.message });
                }
            }
        }

        // Plan step execution (PlanCard Approve / Continue / Skip) arrives on
        // this route with plan_action 'execute_next'.  It delegates to the
        // service agent, so it needs execute mode — same guard as /plan/*.
        if (workflow_context && workflow_context.plan_action === 'execute_next') {
            if (!(await requireExecuteMode(res, session_id, logger))) return;
        }

        // Validate attached files (10 MB cap, null-byte rejection)
        let validatedFiles = null;
        if (Array.isArray(files) && files.length > 0) {
            const maxFiles = 3;
            const maxFileSize = 10 * 1024 * 1024; // 10 MB
            validatedFiles = files.slice(0, maxFiles).filter(f => {
                if (!f || typeof f.content !== 'string') return false;
                const byteLen = Buffer.byteLength(f.content, 'utf8');
                if (byteLen > maxFileSize) {
                    logger.warn(`File "${f.name}" exceeds 10 MB limit (${byteLen} bytes), skipping`);
                    return false;
                }
                if (f.content.indexOf('\0') !== -1) {
                    logger.warn(`File "${f.name}" contains null bytes (binary), skipping`);
                    return false;
                }
                return true;
            }).map(f => ({
                name: f.name || 'unnamed_file',
                content: f.content,
                mime_type: f.mime_type || 'text/plain',
                size: f.size || Buffer.byteLength(f.content, 'utf8')
            }));
            if (validatedFiles.length === 0) validatedFiles = null;
        }

        // Validate attached PDFs
        let validatedPdfs = null;
        if (Array.isArray(pdfs) && pdfs.length > 0) {
            const maxPdfDecodedSize = 10 * 1024 * 1024; // 10 MB decoded
            validatedPdfs = pdfs.filter(p => {
                if (!p || typeof p.content !== 'string') return false;
                // Strip data URI prefix if present
                let raw = p.content;
                if (raw.startsWith('data:')) {
                    const commaIdx = raw.indexOf(',');
                    if (commaIdx !== -1) raw = raw.substring(commaIdx + 1);
                }
                // Estimate decoded size: base64 is ~4/3 of original
                const estimatedBytes = Math.ceil(raw.length * 3 / 4);
                if (estimatedBytes > maxPdfDecodedSize) {
                    logger.warn(`PDF "${p.name}" exceeds 10 MB limit (${estimatedBytes} bytes), skipping`);
                    return false;
                }
                // Verify %PDF- magic bytes in the first few decoded bytes
                try {
                    const head = Buffer.from(raw.substring(0, 20), 'base64');
                    if (!head.toString('ascii', 0, 5).startsWith('%PDF-')) {
                        logger.warn(`PDF "${p.name}" does not have PDF magic bytes, skipping`);
                        return false;
                    }
                } catch (e) {
                    logger.warn(`PDF "${p.name}" failed base64 decode check, skipping`);
                    return false;
                }
                return true;
            }).map(p => ({
                name: p.name || 'document.pdf',
                content: p.content,
                mime_type: 'application/pdf',
                size: p.size || 0
            }));
            if (validatedPdfs.length === 0) validatedPdfs = null;
        }

        // Enforce combined attachment cap: images + files + pdfs <= 3.
        // Trim PDFs first, then files, then images — images are usually the
        // page screenshot, which is the most useful context to keep. Each
        // step recomputes its slots from the already-trimmed others, so the
        // total always lands at or under the cap.
        // The browser enforces 3 slots in CopilotInput.js; this is the
        // server-side backstop for direct API calls.
        const MAX_TOTAL_ATTACHMENTS = 3;
        const countOf = (arr) => (Array.isArray(arr) ? arr.length : 0);
        let validatedImages = images;

        const totalAttachments = countOf(validatedImages)
            + countOf(validatedFiles)
            + countOf(validatedPdfs);
        if (totalAttachments > MAX_TOTAL_ATTACHMENTS) {
            logger.warn(`Total attachments (${totalAttachments}) exceed cap of ${MAX_TOTAL_ATTACHMENTS}, trimming`);

            // 1. PDFs are dropped first.
            const pdfSlots = Math.max(0, MAX_TOTAL_ATTACHMENTS - countOf(validatedImages) - countOf(validatedFiles));
            if (countOf(validatedPdfs) > pdfSlots) {
                validatedPdfs = pdfSlots > 0 ? validatedPdfs.slice(0, pdfSlots) : null;
            }

            // 2. Then text files.
            const fileSlots = Math.max(0, MAX_TOTAL_ATTACHMENTS - countOf(validatedImages) - countOf(validatedPdfs));
            if (countOf(validatedFiles) > fileSlots) {
                validatedFiles = fileSlots > 0 ? validatedFiles.slice(0, fileSlots) : null;
            }

            // 3. Then images, which have the highest retention priority.
            const imageSlots = Math.max(0, MAX_TOTAL_ATTACHMENTS - countOf(validatedFiles) - countOf(validatedPdfs));
            if (countOf(validatedImages) > imageSlots) {
                validatedImages = imageSlots > 0 ? validatedImages.slice(0, imageSlots) : null;
            }

            logger.warn('Attachments trimmed to cap', {
                images: countOf(validatedImages),
                files: countOf(validatedFiles),
                pdfs: countOf(validatedPdfs),
            });
        }

        // Keep image_attachments index-aligned with the (possibly trimmed)
        // images — orchestratorClient reads metaArray[i] per image.
        let validatedImageAttachments = image_attachments;
        if (Array.isArray(validatedImageAttachments)
            && validatedImageAttachments.length > countOf(validatedImages)) {
            const keep = countOf(validatedImages);
            validatedImageAttachments = keep > 0 ? validatedImageAttachments.slice(0, keep) : null;
        }

        // Validate required fields
        if (!query || !model) {
            logger.warn('Missing required fields', {
                has_query: !!query,
                has_model: !!model
            });
            return res.status(400).json({
                message: 'Missing required fields',
                required: ['query', 'model']
            });
        }

        // Treat 0 (or negative) as unlimited.
        const configuredMaxIterations = config.agent?.max_iterations;
        const max_iterations = (typeof configuredMaxIterations === 'number' && configuredMaxIterations <= 0)
            ? Number.POSITIVE_INFINITY
            : (configuredMaxIterations || 3);

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
            has_images: countOf(validatedImages) > 0,
            images_count: countOf(validatedImages),
            has_files: countOf(validatedFiles) > 0,
            files_count: countOf(validatedFiles),
            has_pdfs: countOf(validatedPdfs) > 0,
            pdfs_count: countOf(validatedPdfs)
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

        if (stream) {
            // ========== STREAMING PATH (in-request, no Bull) ==========
            logger.info('Running chat turn in-request', { session_id, user_id });

            // runChatTurn sets up SSE headers, heartbeat, and calls
            // executeOrchestratorLoop directly. Session switch closes
            // the SSE stream but does NOT cancel the turn. Only
            // POST /job/:id/abort sets the Redis cancel flag.
            await runChatTurn(req, res, {
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
                images: validatedImages,
                image_attachments: validatedImageAttachments,
                files: validatedFiles,
                pdfs: validatedPdfs,
                // Only consulted for ephemeral (save_chat:false) turns,
                // which have no session document to read the mode from.
                execution_mode,
                // One-shot execute ("allow once"): this turn runs in execute
                // mode; the stored session mode is not changed.
                execute_once: execute_once === true,
                target_agent,
                workflow_context,
            });

        } else {
            // Non-streaming path removed — all chat runs in-request via SSE.
            res.status(400).json({
                error: 'Non-streaming mode is no longer supported. Use stream=true.'
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

// GET /job/:jobId/status — removed (Bull queue status polling, dead code)
// GET /queue/stats — removed (Bull queue monitoring, dead code)

// ========== JOB ABORT ROUTE ==========
router.post('/job/:jobId/abort', requireAuth, async (req, res) => {
    const logger = createLogger('JobAbort');

    try {
        const { jobId } = req.params;

        logger.info('Job abort (Stop) request', { jobId });

        // Only the owner of the turn may stop it. A job that is not (or no
        // longer) a session's active turn has nothing to protect: setting a
        // cancel flag for it is a no-op.
        const sessionId = await getSessionIdForActiveJob(jobId);
        if (sessionId && !(await canAccessSession(sessionId, req.user))) {
            return res.status(403).json({ message: 'Not authorized to stop this job' });
        }

        // Set the Redis cancel flag. Any gateway instance can call this
        // route — the flag is checked by the in-request runner's
        // shouldCancel poll and by the orchestrator's abort logic.
        await setCancelFlag(jobId);

        return res.status(202).json({
            message: 'Stop requested',
            job_id: jobId,
            note: 'Cancel flag set; turn will stop at next checkpoint',
        });
    } catch (error) {
        logger.error('Failed to set cancel flag', {
            error: error.message,
            jobId: req.params.jobId
        });

        return res.status(500).json({
            message: 'Failed to request stop',
            error: error.message
        });
    }
});

// GET /job/:jobId/stream — removed (Bull stream reconnection, dead code)
// All RAG queue routes removed (RAG pipeline no longer used)

// POST /rag, POST /rag/stream, POST /chat-image — removed (deprecated, no longer called by frontend)
// POST /copilot, /chat, /chat-only, /demo, /setup-copilot-stream, /copilot-stream,
// /mcp/replay-tool-call, /submit-workflow/:id, /workflow-complete, GET /rag-chunk-search
// — removed 2026-10-08 (no callers; /chat-only was an open LLM relay and
// /workflow-complete an unauthenticated message writer — the Bull poller in
// workflowMonitorService delivers completion messages)

// ========== SESSION MANAGEMENT ENDPOINTS ==========
// Chat session creation, retrieval, and management

router.get('/start-chat', requireAuth, (req, res) => {
    const sessionId = uuidv4();
    res.status(200).json({ message: 'created session id', session_id: sessionId, user_id: req.user });
});

router.post('/register-session', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { session_id, title } = req.body || {};
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

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

router.post('/add-workflow-to-session', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { session_id, workflow_id } = req.body || {};
        if (!session_id || !workflow_id) {
            return res.status(400).json({ message: 'session_id and workflow_id are required' });
        }
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

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

router.get('/get-session-messages', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        const session = await getChatSession(session_id);
        if (session && session.user_id && session.user_id !== user_id) {
            return res.status(403).json({ message: 'Not authorized to access this session' });
        }
        const workflowIds = session?.workflow_ids || [];

        const includeFiles = parseBooleanFlag(req.query.include_files, false);
        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 20;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;

        const messages = await getSessionMessages(session_id);

        // Debug: Log messages with tool_call before sending to frontend
        console.log('********** Messages being sent to frontend **********');
        messages.forEach((msg, idx) => {
            if (msg.tool_call) {
                console.log(`Message ${idx} has tool_call:`, msg.tool_call);
            }
        });

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

        // Include active_job_id so the frontend knows if this session
        // has an in-flight turn (for busy indicator / poll-on-return).
        const activeJobId = session?.active_job_id || null;
        // Plan/Execute toggle state — the frontend restores it on session switch.
        const executionMode = normalizeExecutionMode(session?.execution_mode);

        if (!includeFiles) {
            const payload = {
                messages,
                workflow_ids: workflowIds,
                workflow_grid: workflowGrid,
                active_job_id: activeJobId,
                execution_mode: executionMode
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
            active_job_id: activeJobId,
            execution_mode: executionMode,
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

router.get('/get-session-files', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 20;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;

        const session = await getChatSession(session_id);
        if (session && session.user_id && session.user_id !== user_id) {
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

router.get('/get-session-title', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const session_id = req.query.session_id;
        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }

        // Verify session ownership
        const session = await getChatSession(session_id);
        if (session && session.user_id && session.user_id !== req.user) {
            return res.status(403).json({ message: 'Not authorized to access this session' });
        }

        const title = await getSessionTitle(session_id);
        res.status(200).json({ title });
    } catch (error) {
        console.error('Error retrieving session title:', error);
        res.status(500).json({ message: 'Failed to retrieve session title', error: error.message });
    }
});

router.get('/get-all-sessions', requireAuth, async (req, res) => {
    try {
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

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

router.get('/get-user-workflows', requireAuth, async (req, res) => {
    try {
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        const limitParam = parseInt(req.query.limit, 10);
        const offsetParam = parseInt(req.query.offset, 10);
        const limit = (!isNaN(limitParam) && limitParam > 0) ? Math.min(limitParam, 1000) : 200;
        const offset = (!isNaN(offsetParam) && offsetParam >= 0) ? offsetParam : 0;
        const statusFilter = req.query.status ? String(req.query.status).toLowerCase().trim() : '';

        const authHeader = req.headers ? req.headers.authorization : '';
        const workflowBaseUrl = process.env.WORKFLOW_URL || config.workflow_url || 'https://dev-7.bv-brc.org/api/v1';

        // Primary: query the Workflow Engine's list-by-user endpoint directly.
        // This returns all workflows owned by the user (matched via auth_token
        // ``un=`` field or the explicit ``owner`` field on the document).
        try {
            const engineUrl = `${workflowBaseUrl}/workflows`;
            const params = { owner: user_id, limit, skip: offset };
            if (statusFilter) params.status = statusFilter;

            const engineResponse = await axios.get(engineUrl, {
                params,
                headers: {
                    Accept: 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {})
                },
                timeout: 15000
            });

            if (engineResponse.data && Array.isArray(engineResponse.data.workflows)) {
                return res.status(200).json({
                    user_id,
                    workflows: engineResponse.data.workflows,
                    total: engineResponse.data.total || engineResponse.data.workflows.length,
                    limit,
                    offset,
                    has_more: engineResponse.data.has_more || false
                });
            }
        } catch (engineError) {
            // Workflow Engine list endpoint unavailable — fall back to
            // session-based workflow discovery below.
            console.warn(
                '[get-user-workflows] Workflow Engine list endpoint unavailable, ' +
                'falling back to session-based lookup:',
                engineError.message
            );
        }

        // Fallback: legacy session-based workflow discovery via chat_sessions.workflow_ids
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

router.get('/get-user-workflow-summary', requireAuth, async (req, res) => {
    try {
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        const authHeader = req.headers ? req.headers.authorization : '';
        const workflowBaseUrl = process.env.WORKFLOW_URL || config.workflow_url || 'https://dev-7.bv-brc.org/api/v1';

        let workflows;

        // Primary: use Workflow Engine list-by-user endpoint
        try {
            const engineResponse = await axios.get(`${workflowBaseUrl}/workflows`, {
                params: { owner: user_id, limit: 1000 },
                headers: {
                    Accept: 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {})
                },
                timeout: 15000
            });

            if (engineResponse.data && Array.isArray(engineResponse.data.workflows)) {
                workflows = engineResponse.data.workflows;
            }
        } catch (engineError) {
            console.warn(
                '[get-user-workflow-summary] Workflow Engine list endpoint unavailable, ' +
                'falling back to session-based lookup:',
                engineError.message
            );
        }

        // Fallback: legacy session-based workflow discovery
        if (!workflows) {
            workflows = await getUserWorkflowsWithDetail(user_id, authHeader);
        }

        const summary = {
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0
        };

        workflows.forEach((workflow) => {
            // Normalize status to match the summary buckets
            const rawStatus = (workflow.status || '').toLowerCase();
            let key;
            if (['planned', 'queued', 'init', 'pending'].includes(rawStatus)) {
                key = 'pending';
            } else if (['in-progress', 'running'].includes(rawStatus)) {
                key = 'running';
            } else if (['completed', 'complete', 'success', 'succeeded'].includes(rawStatus)) {
                key = 'completed';
            } else if (['failed', 'error', 'cancelled', 'canceled'].includes(rawStatus)) {
                key = 'failed';
            }
            if (key && Object.prototype.hasOwnProperty.call(summary, key)) {
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

// ---------------------------------------------------------------------------
// Planning Agent endpoints
// ---------------------------------------------------------------------------

/**
 * Answer clarification questions from the planning agent.
 * No planId required — the plan doesn't exist yet at this point.
 */
router.post('/answer-questions', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('AnswerQuestions', req.body.session_id);
    try {
        const {
            answers,
            original_query,
            session_id,
            model = null
        } = req.body;

        if (!answers || !Array.isArray(answers) || answers.length === 0) {
            return res.status(400).json({ message: 'answers array is required' });
        }
        if (!original_query) {
            return res.status(400).json({ message: 'original_query is required' });
        }

        const auth_token = req.authToken || null;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        await runChatTurn(req, res, {
            query: original_query,
            model,
            session_id,
            user_id,
            save_chat: true,
            include_history: true,
            auth_token,
            target_agent: 'planning',
            workflow_context: {
                plan_action: 'answer_questions',
                clarification_answers: answers
            }
        });

        logger.info('Answer-questions turn completed', { session_id });

    } catch (error) {
        logger.error('Error in answer-questions', { error: error.message });
        if (!res.headersSent) {
            return res.status(500).json({ message: 'Internal server error', error: error.message });
        }
    }
});

/**
 * Approve a plan and start executing the first step.
 */
router.post('/plan/:planId/approve', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('ApprovePlan', req.body.session_id);
    try {
        const { planId } = req.params;
        const { plan, session_id, model = null } = req.body;

        if (!plan || !plan.steps || plan.steps.length === 0) {
            return res.status(400).json({ message: 'plan with steps is required' });
        }

        const auth_token = req.authToken || null;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        if (!(await requireExecuteMode(res, session_id, logger))) return;

        await runChatTurn(req, res, {
            query: `Execute step 1 of approved plan: ${plan.title}`,
            model,
            session_id,
            user_id,
            save_chat: true,
            include_history: true,
            auth_token,
            target_agent: 'planning',
            workflow_context: {
                plan: plan,
                plan_action: 'execute_next',
                current_step_index: 0,
                completed_step_results: {}
            }
        });

        logger.info('Plan approval turn completed', { planId, session_id });

    } catch (error) {
        logger.error('Error in plan approve', { error: error.message });
        if (!res.headersSent) {
            return res.status(500).json({ message: 'Internal server error', error: error.message });
        }
    }
});

/**
 * Execute the next step in a plan.
 */
router.post('/plan/:planId/execute-next', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('ExecuteNextStep', req.body.session_id);
    try {
        const { planId } = req.params;
        const {
            plan,
            session_id,
            current_step_index,
            completed_step_results = {},
            model = null
        } = req.body;

        if (!plan || current_step_index === undefined) {
            return res.status(400).json({ message: 'plan and current_step_index are required' });
        }

        const auth_token = req.authToken || null;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        if (!(await requireExecuteMode(res, session_id, logger))) return;

        await runChatTurn(req, res, {
            query: `Execute step ${current_step_index + 1} of plan: ${plan.title}`,
            model,
            session_id,
            user_id,
            save_chat: true,
            include_history: true,
            auth_token,
            target_agent: 'planning',
            workflow_context: {
                plan: plan,
                plan_action: 'execute_next',
                current_step_index: current_step_index,
                completed_step_results: completed_step_results
            }
        });

        logger.info('Execute-next turn completed', { planId, session_id, step: current_step_index });

    } catch (error) {
        logger.error('Error in execute-next', { error: error.message });
        if (!res.headersSent) {
            return res.status(500).json({ message: 'Internal server error', error: error.message });
        }
    }
});

/**
 * Skip a step during plan execution.
 */
router.post('/plan/:planId/skip-step/:stepId', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('SkipStep', req.body.session_id);
    try {
        const { planId, stepId } = req.params;
        const {
            plan,
            session_id,
            current_step_index,
            completed_step_results = {},
            model = null
        } = req.body;

        if (!plan) {
            return res.status(400).json({ message: 'plan is required' });
        }

        const auth_token = req.authToken || null;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        if (!(await requireExecuteMode(res, session_id, logger))) return;

        // Mark the step as skipped
        const updatedPlan = JSON.parse(JSON.stringify(plan));
        const stepToSkip = updatedPlan.steps.find(s => s.step_id === stepId);
        if (stepToSkip) {
            stepToSkip.status = 'skipped';
        }

        // Find next non-skipped pending step
        let nextIndex = current_step_index;
        while (nextIndex < updatedPlan.steps.length &&
               updatedPlan.steps[nextIndex].status !== 'pending') {
            nextIndex++;
        }

        if (nextIndex >= updatedPlan.steps.length) {
            // All remaining steps skipped — plan complete
            updatedPlan.status = 'completed';
            return res.json({ status: 'plan_completed', plan: updatedPlan });
        }

        await runChatTurn(req, res, {
            query: `Execute next step of plan: ${updatedPlan.title}`,
            model,
            session_id,
            user_id,
            save_chat: true,
            include_history: true,
            auth_token,
            target_agent: 'planning',
            workflow_context: {
                plan: updatedPlan,
                plan_action: 'execute_next',
                current_step_index: nextIndex,
                completed_step_results: completed_step_results
            }
        });

        logger.info('Skip-step turn completed', { planId, stepId, session_id });

    } catch (error) {
        logger.error('Error in skip-step', { error: error.message });
        if (!res.headersSent) {
            return res.status(500).json({ message: 'Internal server error', error: error.message });
        }
    }
});

/**
 * Edit remaining steps of a plan (non-streaming, just updates state).
 */
router.post('/plan/:planId/edit', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { planId } = req.params;
        const { plan, session_id } = req.body;

        if (!plan) {
            return res.status(400).json({ message: 'plan is required' });
        }

        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });

        if (session_id) {
            const { updatePlanInSession } = require('../services/dbUtils');
            await updatePlanInSession(session_id, planId, plan);
        }

        res.json({ status: 'updated', plan });
    } catch (error) {
        return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

router.post('/generate-title-from-messages', requireAuth, async (req, res) => {
    try {
        const { model, messages, user_id } = req.body;
        const message_str = messages.map(msg => `message: ${msg}`).join('\n\n');
        const titlePrompt = promptManager.getChatPrompt('titleGeneration');
        const query = `${titlePrompt}\n\n${message_str}`;

        const modelData = await getModelData(model);
        const queryType = modelData['queryType'];
        let response;

        // Skip title generation for Argo models (endpoint not reachable from this host)
        if (queryType === 'argo') {
            return res.status(200).json({ message: 'skipped', response: 'New Chat' });
        }

        if (queryType === 'client') {
            const openai_client = ChatService.getOpenaiClient(modelData);
            const queryMsg = [{ role: 'user', content: query }];
            response = await ChatService.queryModel(openai_client, model, queryMsg);
        } else if (queryType === 'request') {
            response = await ChatService.queryRequest(modelData.endpoint, model, '', query);
        } else {
            return res.status(500).json({ message: 'Invalid query type', queryType });
        }

        res.status(200).json({ message: 'success', response });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

router.post('/update-session-title', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { title, session_id } = req.body;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;
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

/**
 * Persist the Plan/Execute toggle for a chat session.
 * Body: { session_id, execution_mode: 'plan' | 'execute' }
 */
router.post('/update-session-execution-mode', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { session_id, execution_mode } = req.body;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        if (!session_id) {
            return res.status(400).json({ message: 'session_id is required' });
        }
        if (!isValidExecutionMode(execution_mode)) {
            return res.status(400).json({ message: `execution_mode must be one of: plan, execute` });
        }

        // The session may not exist yet (toggle flipped before the first
        // message) — register it so the mode is not lost.
        await registerChatSession(session_id, user_id);
        const updateResult = await setSessionExecutionMode(session_id, user_id, execution_mode);

        if (updateResult.matchedCount === 0) {
            return res.status(404).json({ message: 'Session not found or user not authorized' });
        }

        res.status(200).json({ session_id, execution_mode });
    } catch (error) {
        console.error('Error updating session execution mode:', error);
        res.status(500).json({ message: 'Failed to update session execution mode', error: error.message });
    }
});

router.post('/delete-session', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { session_id } = req.body;
        if (!session_id) {
            return res.status(400).json({ message: 'Session ID is required' });
        }
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

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

// ========== USER PROMPTS MANAGEMENT ==========
// Saved prompts and templates for users

router.get('/get-user-prompts', requireAuth, async (req, res) => {
    try {
        const resolved = resolveUserId(req, req.query.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;
        const prompts = await getUserPrompts(user_id);
        res.status(200).json({ prompts });
    } catch (error) {
        console.error('Error getting user prompts:', error);
        res.status(500).json({ message: 'Failed getting user prompts', error: error.message });
    }
});

router.post('/save-prompt', requireAuth, async (req, res) => {
    try {
        const { name, text } = req.body;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;
        const updateResult = await saveUserPrompt(user_id, name, text);
        res.status(200).json({ update_result: updateResult, title: name, content: text });
    } catch (error) {
        console.error('Error saving user prompt:', error);
        res.status(500).json({ message: 'Failed saving user prompt', error: error.message });
    }
});

// ========== RATING & FEEDBACK ENDPOINTS ==========
// User feedback and rating system

router.post('/rate-conversation', requireAuth, requireSessionOwner, async (req, res) => {
    try {
        const { session_id, rating } = req.body;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        // Validate required fields
        if (!session_id || rating === undefined) {
            return res.status(400).json({
                message: 'session_id and rating are required'
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

router.post('/rate-message', requireAuth, async (req, res) => {
    try {
        const { message_id, rating } = req.body;
        const resolved = resolveUserId(req, req.body.user_id);
        if (resolved.error) return res.status(resolved.status).json({ message: resolved.error });
        const user_id = resolved.userId;

        // Validate required fields
        if (!message_id || rating === undefined) {
            return res.status(400).json({
                message: 'message_id and rating are required'
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

// ========== UTILITY ENDPOINTS ==========

router.post('/get-path-state', requireAuth, async (req, res) => {
    try {
        const { path } = req.body;
        const { getPathState } = require('../services/pathStateService');
        const pathState = await getPathState(path);
        res.status(200).json({ message: 'success', pathState });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Internal server error', error });
    }
});

// ---------------------------------------------------------------------------
// Workflow watch status -- lightweight polling endpoint for the frontend
// PlanCard to check whether a watched workflow has completed.
// ---------------------------------------------------------------------------
router.get('/workflow-watch/:submissionId/status', requireAuth, async (req, res) => {
    const logger = createLogger('WorkflowWatchStatus');
    try {
        const { submissionId } = req.params;
        if (!submissionId) {
            return res.status(400).json({ error: 'submissionId is required' });
        }

        const db = await connectToDatabase();
        const watch = await db.collection('workflow_watches').findOne({
            submission_id: submissionId
        });

        if (!watch || !watch.session_id || !(await canAccessSession(watch.session_id, req.user))) {
            return res.status(404).json({ error: 'No watch found for this submission' });
        }

        // Return a lightweight status response
        return res.json({
            submission_id: watch.submission_id,
            workflow_id: watch.workflow_id,
            status: watch.status,           // "active" | "completed" | "failed"
            gowe_state: watch.gowe_state,   // "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"
            external_ids: watch.external_ids || [],
            plan_id: watch.plan_id || null,
            step_id: watch.step_id || null,
            step_index: watch.step_index,
            last_checked: watch.last_checked,
            completed_at: watch.completed_at
        });

    } catch (error) {
        logger.error('Error checking workflow watch status', { error: error.message });
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
// Session workflow watches -- returns all workflow watches for a given
// chat session, including external_ids (BV-BRC job IDs).
// ---------------------------------------------------------------------------
router.get('/session/:sessionId/workflow-watches', requireAuth, requireSessionOwner, async (req, res) => {
    const logger = createLogger('SessionWorkflowWatches');
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        const db = await connectToDatabase();
        const watches = await db.collection('workflow_watches').find({
            session_id: sessionId
        }).sort({ created_at: -1 }).toArray();

        const results = watches.map(w => ({
            submission_id: w.submission_id,
            workflow_id: w.workflow_id,
            status: w.status,
            gowe_state: w.gowe_state,
            external_ids: w.external_ids || [],
            created_at: w.created_at,
            completed_at: w.completed_at,
            last_checked: w.last_checked
        }));

        return res.json({ watches: results, count: results.length });

    } catch (error) {
        logger.error('Error fetching session workflow watches', { error: error.message });
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
