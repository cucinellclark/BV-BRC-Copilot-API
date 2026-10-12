/**
 * Tests for the Plan / Execute execution mode plumbing in the gateway.
 *
 *  - POST /update-session-execution-mode
 *  - POST /copilot-agent write-through of execution_mode
 *  - 409 PLAN_MODE guard on /plan/:id/approve, /execute-next, /skip-step
 *  - mapOrchestratorEvent('execution_blocked') -> SSE + persisted card
 *  - normalizeExecutionMode / isValidExecutionMode helpers
 *  - POST /copilot-agent replay_actions (checked against the stored card)
 *
 * Mocks MongoDB access (dbUtils) so no database is needed.
 */

const express = require('express');
const http = require('http');

const mockGetChatSession = jest.fn();
const mockSetSessionExecutionMode = jest.fn();
const mockRegisterChatSession = jest.fn();

jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return {
        ...actual,
        getChatSession: mockGetChatSession,
        getSessionOwnerIds: jest.fn().mockResolvedValue([]),
        getSessionIdForActiveJob: jest.fn().mockResolvedValue(null),
        setSessionExecutionMode: mockSetSessionExecutionMode,
        registerChatSession: mockRegisterChatSession,
        getModelData: jest.fn(),
        getSessionMessages: jest.fn(),
        getSessionTitle: jest.fn(),
        getUserSessions: jest.fn(),
        updateSessionTitle: jest.fn(),
        deleteSession: jest.fn(),
        getUserPrompts: jest.fn(),
        saveUserPrompt: jest.fn(),
        addMessagesToSession: jest.fn(),
        addWorkflowIdToSession: jest.fn(),
        rateConversation: jest.fn(),
        rateMessage: jest.fn(),
        getSessionFilesPaginated: jest.fn(),
        getSessionStorageSize: jest.fn(),
        getUserWorkflowIds: jest.fn(),
        searchRagChunkReferences: jest.fn(),
    };
});

jest.mock('../services/mcp/mcpExecutor', () => ({
    executeMcpTool: jest.fn(),
    isReplayableTool: jest.fn(),
}));

jest.mock('../services/logger', () => ({
    createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

jest.mock('../services/database', () => ({
    connectToDatabase: jest.fn().mockResolvedValue({}),
}));

jest.mock('../services/chatService', () => ({}));

jest.mock('../middleware/auth', () => ({
    requireAuth: (req, res, next) => { req.user = 'alice@patricbrc.org'; next(); },
    resolveUserId: (req, userId) => ({ userId: userId || 'alice@patricbrc.org' }),
}));

jest.mock('../prompts', () => ({}));

const mockEmitSSE = jest.fn();
jest.mock('../services/sseUtils', () => ({
    writeSseEvent: jest.fn(),
    emitSSE: mockEmitSSE,
}));

jest.mock('../config.json', () => ({}), { virtual: true });

const mockRunChatTurn = jest.fn(async (req, res) => {
    res.status(200).json({ ran: true });
});
jest.mock('../services/chatRunner', () => ({
    runChatTurn: mockRunChatTurn,
    setCancelFlag: jest.fn(),
    releaseSessionTurnForJob: jest.fn(),
}));

jest.mock('../services/sessionStreamRegistry', () => ({
    register: jest.fn(),
    unregister: jest.fn(),
    pushToSession: jest.fn(),
}));

jest.mock('../services/workflowMonitorService', () => ({
    registerWorkflowWatch: jest.fn(),
}));

jest.mock('../services/memory/conversationContextService', () => ({
    buildConversationContext: jest.fn(),
    buildWorkflowAwareHistory: jest.fn(),
}));

let request;
let server;

beforeAll(() => {
    const chatRoutes = require('../routes/chatRoutes');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/copilot-api/chatbrc', chatRoutes);
    server = http.createServer(app);

    request = (method, path, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({
            method,
            path,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            port: server.address().port,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });

    return new Promise((resolve) => server.listen(0, resolve));
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterChatSession.mockResolvedValue({ created: false });
    mockSetSessionExecutionMode.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

const BASE = '/copilot-api/chatbrc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('execution mode helpers', () => {
    const { normalizeExecutionMode, isValidExecutionMode, DEFAULT_EXECUTION_MODE } =
        jest.requireActual('../services/dbUtils');

    test('default is plan', () => {
        expect(DEFAULT_EXECUTION_MODE).toBe('plan');
    });

    test('normalize treats everything but execute as plan', () => {
        expect(normalizeExecutionMode('execute')).toBe('execute');
        for (const v of ['plan', undefined, null, '', 'auto_all', 'EXECUTE', 1]) {
            expect(normalizeExecutionMode(v)).toBe('plan');
        }
    });

    test('isValid accepts only the two modes', () => {
        expect(isValidExecutionMode('plan')).toBe(true);
        expect(isValidExecutionMode('execute')).toBe(true);
        expect(isValidExecutionMode('auto_all')).toBe(false);
        expect(isValidExecutionMode(undefined)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// POST /update-session-execution-mode
// ---------------------------------------------------------------------------

describe('POST /update-session-execution-mode', () => {
    test('persists a valid mode', async () => {
        const res = await request('POST', `${BASE}/update-session-execution-mode`, {
            session_id: 's1', execution_mode: 'execute',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ session_id: 's1', execution_mode: 'execute' });
        expect(mockRegisterChatSession).toHaveBeenCalledWith('s1', 'alice@patricbrc.org');
        expect(mockSetSessionExecutionMode).toHaveBeenCalledWith('s1', 'alice@patricbrc.org', 'execute');
    });

    test('rejects an invalid mode', async () => {
        const res = await request('POST', `${BASE}/update-session-execution-mode`, {
            session_id: 's1', execution_mode: 'auto_all',
        });
        expect(res.status).toBe(400);
        expect(mockSetSessionExecutionMode).not.toHaveBeenCalled();
    });

    test('requires session_id', async () => {
        const res = await request('POST', `${BASE}/update-session-execution-mode`, {
            execution_mode: 'plan',
        });
        expect(res.status).toBe(400);
    });

    test('404 when the session is not owned', async () => {
        mockSetSessionExecutionMode.mockResolvedValueOnce({ matchedCount: 0 });
        const res = await request('POST', `${BASE}/update-session-execution-mode`, {
            session_id: 'other', execution_mode: 'plan',
        });
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// POST /copilot-agent write-through
// ---------------------------------------------------------------------------

describe('POST /copilot-agent execution_mode write-through', () => {
    test('persists execution_mode before running the turn', async () => {
        const order = [];
        mockSetSessionExecutionMode.mockImplementation(async () => { order.push('persist'); return { matchedCount: 1 }; });
        mockRunChatTurn.mockImplementation(async (req, res) => { order.push('turn'); res.status(200).json({}); });

        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'assemble SRR1', model: 'm', session_id: 's1', execution_mode: 'execute', stream: true,
        });
        expect(res.status).toBe(200);
        expect(mockSetSessionExecutionMode).toHaveBeenCalledWith('s1', 'alice@patricbrc.org', 'execute');
        expect(order).toEqual(['persist', 'turn']);
        // The mode is forwarded as job data only for ephemeral turns; for a
        // persisted turn the loop reads it back from the session document.
        const jobData = mockRunChatTurn.mock.calls[0][2];
        expect(jobData.execution_mode).toBe('execute');
        expect(jobData).not.toHaveProperty('auto_submit_preference');
    });

    test('does not persist when execution_mode is absent', async () => {
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'hello', model: 'm', session_id: 's1', stream: true,
        });
        expect(res.status).toBe(200);
        expect(mockSetSessionExecutionMode).not.toHaveBeenCalled();
    });

    test('rejects an invalid execution_mode', async () => {
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'hello', model: 'm', session_id: 's1', execution_mode: 'auto_all', stream: true,
        });
        expect(res.status).toBe(400);
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test('skips persistence when save_chat is false but forwards the mode', async () => {
        await request('POST', `${BASE}/copilot-agent`, {
            query: 'hello', model: 'm', session_id: 's1', execution_mode: 'execute', save_chat: false, stream: true,
        });
        expect(mockSetSessionExecutionMode).not.toHaveBeenCalled();
        expect(mockRunChatTurn).toHaveBeenCalled();
        expect(mockRunChatTurn.mock.calls[0][2].execution_mode).toBe('execute');
    });
});

// ---------------------------------------------------------------------------
// execute_once ("allow once")
// ---------------------------------------------------------------------------

describe('POST /copilot-agent execute_once', () => {
    test('forwards execute_once without touching the stored mode', async () => {
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'Submit the job exactly as prepared', model: 'm', session_id: 's1',
            execute_once: true, stream: true,
        });
        expect(res.status).toBe(200);
        expect(mockSetSessionExecutionMode).not.toHaveBeenCalled();
        const jobData = mockRunChatTurn.mock.calls[0][2];
        expect(jobData.execute_once).toBe(true);
    });

    test('non-boolean execute_once is ignored', async () => {
        await request('POST', `${BASE}/copilot-agent`, {
            query: 'hello', model: 'm', session_id: 's1', execute_once: 'yes', stream: true,
        });
        expect(mockRunChatTurn.mock.calls[0][2].execute_once).toBe(false);
    });

    test('execute_once does not bypass the plan-step guard', async () => {
        // Plan steps span many turns; "once" is only for the blocked card.
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'Execute approved plan', model: 'm', session_id: 's1', stream: true,
            execute_once: true, target_agent: 'planning',
            workflow_context: { plan: { title: 't', steps: [{ step_id: 's-1', status: 'pending' }] }, plan_action: 'execute_next', current_step_index: 0 },
        });
        expect(res.status).toBe(409);
    });
});

// ---------------------------------------------------------------------------
// replay_actions ("Submit this job" replays the card's calls verbatim)
// ---------------------------------------------------------------------------

describe('POST /copilot-agent replay_actions', () => {
    const ACTION = {
        tool: 'submit_gowe_job',
        summary: 'Taxonomic Classification → tc_run',
        arguments: { workflow_id: 'wf_tc', inputs: { database: 'SILVA', host_genome: 'no_host', output_path: 'tc_run' } },
    };
    // Same action with keys in a different order, as Mongo might return it.
    const STORED_ACTION = {
        arguments: { inputs: { output_path: 'tc_run', host_genome: 'no_host', database: 'SILVA' }, workflow_id: 'wf_tc' },
        tool: 'submit_gowe_job',
        summary: 'Taxonomic Classification → tc_run',
    };
    const sessionWithCard = (actions) => ({
        session_id: 's1',
        messages: [
            { role: 'user', content: 'run taxonomic classification' },
            { role: 'assistant', content: 'Ready to submit', card: { card_type: 'execution_blocked', card_payload: { agent: 'data', blocked_actions: actions } } },
        ],
    });
    const send = (extra) => request('POST', `${BASE}/copilot-agent`, {
        query: 'Submit the job exactly as you prepared it above.', model: 'm', session_id: 's1', stream: true,
        execute_once: true, target_agent: 'data', ...extra,
    });

    test('forwards matching actions and pins the service agent', async () => {
        mockGetChatSession.mockResolvedValue(sessionWithCard([STORED_ACTION]));
        const res = await send({ replay_actions: [ACTION] });
        expect(res.status).toBe(200);
        const jobData = mockRunChatTurn.mock.calls[0][2];
        expect(jobData.target_agent).toBe('service');
        expect(jobData.replay_actions).toEqual([ACTION]);
    });

    test('rejects actions that do not match a stored card', async () => {
        mockGetChatSession.mockResolvedValue(sessionWithCard([STORED_ACTION]));
        const tampered = { ...ACTION, arguments: { ...ACTION.arguments, inputs: { ...ACTION.arguments.inputs, database: 'Standard' } } };
        const res = await send({ replay_actions: [tampered] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('REPLAY_NOT_FOUND');
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test('requires execute_once', async () => {
        const res = await send({ execute_once: false, replay_actions: [ACTION] });
        expect(res.status).toBe(400);
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test('rejects tools that are not replayable', async () => {
        const res = await send({ replay_actions: [{ tool: 'search_data', arguments: { collection: 'genome' } }] });
        expect(res.status).toBe(400);
    });

    test('rejects more than 10 actions', async () => {
        const res = await send({ replay_actions: Array(11).fill(ACTION) });
        expect(res.status).toBe(400);
    });

    test('ephemeral turns skip the stored-card check', async () => {
        const res = await send({ save_chat: false, replay_actions: [ACTION] });
        expect(res.status).toBe(200);
        expect(mockGetChatSession).not.toHaveBeenCalled();
        expect(mockRunChatTurn.mock.calls[0][2].replay_actions).toEqual([ACTION]);
    });

    test('without replay_actions the target agent is left alone', async () => {
        const res = await send({});
        expect(res.status).toBe(200);
        const jobData = mockRunChatTurn.mock.calls[0][2];
        expect(jobData.target_agent).toBe('data');
        expect(jobData.replay_actions).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Plan routes require execute mode
// ---------------------------------------------------------------------------

describe('plan routes require execute mode', () => {
    const plan = { title: 'Batch assembly', steps: [{ step_id: 's-1', status: 'pending' }, { step_id: 's-2', status: 'pending' }] };

    const cases = [
        ['approve', `${BASE}/plan/p1/approve`, { plan, session_id: 's1' }],
        ['execute-next', `${BASE}/plan/p1/execute-next`, { plan, session_id: 's1', current_step_index: 0 }],
        ['skip-step', `${BASE}/plan/p1/skip-step/s-1`, { plan, session_id: 's1', current_step_index: 0 }],
    ];

    test.each(cases)('%s returns 409 PLAN_MODE in plan mode', async (_name, path, body) => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        const res = await request('POST', path, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PLAN_MODE');
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test.each(cases)('%s returns 409 when the session has no mode', async (_name, path, body) => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1' });
        const res = await request('POST', path, body);
        expect(res.status).toBe(409);
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test.each(cases)('%s runs the turn in execute mode', async (_name, path, body) => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'execute' });
        const res = await request('POST', path, body);
        expect(res.status).toBe(200);
        expect(mockRunChatTurn).toHaveBeenCalledTimes(1);
        expect(mockRunChatTurn.mock.calls[0][2].target_agent).toBe('planning');
    });

    test('/copilot-agent with plan_action execute_next is gated', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'Execute approved plan', model: 'm', session_id: 's1', stream: true,
            target_agent: 'planning',
            workflow_context: { plan, plan_action: 'execute_next', current_step_index: 0 },
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PLAN_MODE');
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test('/copilot-agent with plan_action execute_next runs in execute mode', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'execute' });
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'Execute approved plan', model: 'm', session_id: 's1', stream: true,
            target_agent: 'planning',
            workflow_context: { plan, plan_action: 'execute_next', current_step_index: 0 },
        });
        expect(res.status).toBe(200);
        expect(mockRunChatTurn).toHaveBeenCalledTimes(1);
    });

    test('/copilot-agent write-through wins over the stored mode for the guard', async () => {
        // Toggle flipped to execute and sent in the same request: the
        // write-through persists first, so the guard must see execute.
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        mockSetSessionExecutionMode.mockImplementation(async (sid, uid, mode) => {
            mockGetChatSession.mockResolvedValue({ session_id: sid, execution_mode: mode });
            return { matchedCount: 1 };
        });
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'Execute approved plan', model: 'm', session_id: 's1', stream: true,
            execution_mode: 'execute', target_agent: 'planning',
            workflow_context: { plan, plan_action: 'execute_next', current_step_index: 0 },
        });
        expect(res.status).toBe(200);
    });

    test('/copilot-agent with plan_action answer_questions is not gated', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        const res = await request('POST', `${BASE}/copilot-agent`, {
            query: 'answers', model: 'm', session_id: 's1', stream: true,
            target_agent: 'planning',
            workflow_context: { plan, plan_action: 'answer_questions' },
        });
        expect(res.status).toBe(200);
    });

    test('answer-questions is not gated', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan' });
        const res = await request('POST', `${BASE}/answer-questions`, {
            session_id: 's1', answers: [{ question_id: 'q1', answer: 'x' }], original_query: 'q',
        });
        expect(res.status).not.toBe(409);
    });
});

// ---------------------------------------------------------------------------
// mapOrchestratorEvent('execution_blocked')
// ---------------------------------------------------------------------------

describe("mapOrchestratorEvent('execution_blocked')", () => {
    test('emits the SSE event and persists the card on state', () => {
        const { mapOrchestratorEvent } = require('../services/orchestratorClient');
        const state = {};
        const stream = {};
        const blocked = [{ tool: 'submit_gowe_job', summary: 'GenomeAssembly → SRR1', arguments: {} }];

        mapOrchestratorEvent('execution_blocked', {
            agent: 'service', blocked_actions: blocked, original_query: 'assemble SRR1',
        }, stream, state);

        expect(mockEmitSSE).toHaveBeenCalledTimes(1);
        const [target, name, payload] = mockEmitSSE.mock.calls[0];
        expect(target).toBe(stream);
        expect(name).toBe('execution_blocked');
        expect(payload.card.card_type).toBe('execution_blocked');
        expect(payload.card.card_payload).toEqual({
            agent: 'service',
            execution_mode: 'plan',
            blocked_actions: blocked,
            original_query: 'assemble SRR1',
        });
        expect(payload.blocked_actions).toEqual(blocked);
        expect(state.card).toBe(payload.card);
    });

    test('tolerates a missing blocked_actions list', () => {
        const { mapOrchestratorEvent } = require('../services/orchestratorClient');
        const state = {};
        mapOrchestratorEvent('execution_blocked', {}, {}, state);
        expect(state.card.card_payload.blocked_actions).toEqual([]);
        expect(state.card.card_payload.agent).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// routing_override (router replaced its own direct answer) is kept for tracking
// ---------------------------------------------------------------------------

describe("mapOrchestratorEvent('routing_decision') routing_override", () => {
    test('keeps the override on state for agent_metadata', () => {
        const { mapOrchestratorEvent } = require('../services/orchestratorClient');
        const state = {};
        mapOrchestratorEvent('routing_decision', {
            decision: 'agent', agent_key: 'helpdesk', routing_override: 'bvbrc_reference',
        }, {}, state);
        expect(state.routingOverride).toBe('bvbrc_reference');
    });
    test('no override, nothing set', () => {
        const { mapOrchestratorEvent } = require('../services/orchestratorClient');
        const state = {};
        mapOrchestratorEvent('routing_decision', { decision: 'agent', agent_key: 'data' }, {}, state);
        expect(state.routingOverride).toBeUndefined();
    });
});
