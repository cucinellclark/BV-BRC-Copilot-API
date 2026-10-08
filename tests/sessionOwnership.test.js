/**
 * Session ownership: a chat session can only be read, written, stopped or
 * driven by the user who owns it.
 *
 *  - isSameUser / canAccessSession helpers (bare vs realm-qualified ids,
 *    duplicate session documents, nonexistent sessions)
 *  - requireSessionOwner on the session routes: another user's session is
 *    403 and the handler (turn, plan write, title read) never runs
 *  - /job/:jobId/abort and /workflow-watch/:id/status ownership
 *
 * Mocks MongoDB access so no database is needed.
 */

const express = require('express');
const http = require('http');

const ALICE = 'alice@patricbrc.org';
const BOB = 'bob@patricbrc.org';

const mockGetSessionOwnerIds = jest.fn();
const mockGetSessionIdForActiveJob = jest.fn();
const mockUpdatePlanInSession = jest.fn();
const mockGetSessionTitle = jest.fn();
const mockWatchFindOne = jest.fn();
const mockWatchFind = jest.fn();

jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return {
        ...actual,
        getSessionOwnerIds: mockGetSessionOwnerIds,
        getSessionIdForActiveJob: mockGetSessionIdForActiveJob,
        updatePlanInSession: mockUpdatePlanInSession,
        getChatSession: jest.fn().mockResolvedValue(null),
        getSessionTitle: mockGetSessionTitle,
        registerChatSession: jest.fn().mockResolvedValue({ created: false }),
        setSessionExecutionMode: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        getModelData: jest.fn(),
        getSessionMessages: jest.fn().mockResolvedValue([]),
        getUserSessions: jest.fn(),
        updateSessionTitle: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        deleteSession: jest.fn().mockResolvedValue({ deletedCount: 1 }),
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

jest.mock('../services/database', () => ({
    connectToDatabase: jest.fn().mockResolvedValue({
        collection: () => ({
            findOne: mockWatchFindOne,
            find: () => ({ sort: () => ({ toArray: mockWatchFind }) }),
        }),
    }),
}));

jest.mock('../services/mcp/mcpExecutor', () => ({
    executeMcpTool: jest.fn(),
    isReplayableTool: jest.fn(),
}));

jest.mock('../services/logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../services/chatService', () => ({}));

// The caller is whoever the X-Test-User header says (default Alice).
jest.mock('../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        req.user = req.headers['x-test-user'] || 'alice@patricbrc.org';
        req.authToken = 'test-token';
        next();
    },
    resolveUserId: (req) => ({ userId: req.user }),
}));

jest.mock('../prompts', () => ({}));

jest.mock('../services/sseUtils', () => ({ writeSseEvent: jest.fn(), emitSSE: jest.fn() }));

jest.mock('../config.json', () => ({}), { virtual: true });

const mockRunChatTurn = jest.fn(async (req, res) => { res.status(200).json({ ran: true }); });
const mockSetCancelFlag = jest.fn();
jest.mock('../services/chatRunner', () => ({
    runChatTurn: mockRunChatTurn,
    setCancelFlag: mockSetCancelFlag,
}));

jest.mock('../services/sessionStreamRegistry', () => ({
    register: jest.fn(), unregister: jest.fn(), pushToSession: jest.fn(),
}));

jest.mock('../services/workflowMonitorService', () => ({ registerWorkflowWatch: jest.fn() }));

jest.mock('../services/memory/conversationContextService', () => ({
    buildConversationContext: jest.fn(), buildWorkflowAwareHistory: jest.fn(),
}));

const { isSameUser, canAccessSession } = require('../middleware/sessionOwnership');

let request;
let server;

beforeAll(() => {
    const chatRoutes = require('../routes/chatRoutes');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/copilot-api/chatbrc', chatRoutes);
    server = http.createServer(app);

    request = (method, path, body, user = ALICE) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({
            method,
            path,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Test-User': user,
            },
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
    // Session "s-alice" belongs to Alice; anything else does not exist yet.
    mockGetSessionOwnerIds.mockImplementation(async (sid) => (sid === 's-alice' ? [ALICE] : []));
    mockGetSessionIdForActiveJob.mockResolvedValue(null);
    mockGetSessionTitle.mockResolvedValue('Alice chat');
});

const BASE = '/copilot-api/chatbrc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('isSameUser', () => {
    test('exact and case-insensitive realm-qualified match', () => {
        expect(isSameUser(ALICE, ALICE)).toBe(true);
        expect(isSameUser('Alice@PatricBRC.org', ALICE)).toBe(true);
    });

    test('legacy bare username matches its realm-qualified token identity', () => {
        expect(isSameUser('alice', ALICE)).toBe(true);
    });

    test('different users, or a different realm, do not match', () => {
        expect(isSameUser(BOB, ALICE)).toBe(false);
        expect(isSameUser('bob', ALICE)).toBe(false);
        expect(isSameUser('alice@other.org', ALICE)).toBe(false);
    });

    test('missing values never match', () => {
        expect(isSameUser(null, ALICE)).toBe(false);
        expect(isSameUser('', ALICE)).toBe(false);
        expect(isSameUser(ALICE, undefined)).toBe(false);
    });
});

describe('canAccessSession', () => {
    test('a nonexistent session is accessible (first turn creates it)', async () => {
        mockGetSessionOwnerIds.mockResolvedValueOnce([]);
        await expect(canAccessSession('new', ALICE)).resolves.toBe(true);
    });

    test('own session yes, someone else\'s no', async () => {
        mockGetSessionOwnerIds.mockResolvedValueOnce([ALICE]);
        await expect(canAccessSession('s', ALICE)).resolves.toBe(true);
        mockGetSessionOwnerIds.mockResolvedValueOnce([BOB]);
        await expect(canAccessSession('s', ALICE)).resolves.toBe(false);
    });

    test('a duplicate document planted under another user blocks access', async () => {
        mockGetSessionOwnerIds.mockResolvedValueOnce([BOB, ALICE]);
        await expect(canAccessSession('s', ALICE)).resolves.toBe(false);
    });

    test('no authenticated user is never allowed', async () => {
        await expect(canAccessSession('s', undefined)).resolves.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('requireSessionOwner on session routes', () => {
    test('owner can run a turn', async () => {
        const r = await request('POST', `${BASE}/copilot-agent`,
            { query: 'hi', model: 'm', session_id: 's-alice', save_chat: false, stream: true });
        expect(r.status).toBe(200);
        expect(mockRunChatTurn).toHaveBeenCalled();
    });

    test('a brand-new session id is allowed', async () => {
        const r = await request('POST', `${BASE}/copilot-agent`,
            { query: 'hi', model: 'm', session_id: 's-new', save_chat: false, stream: true });
        expect(r.status).toBe(200);
    });

    test('another user cannot run a turn in the session', async () => {
        const r = await request('POST', `${BASE}/copilot-agent`,
            { query: 'hi', model: 'm', session_id: 's-alice', stream: true }, BOB);
        expect(r.status).toBe(403);
        expect(mockRunChatTurn).not.toHaveBeenCalled();
    });

    test('another user cannot rewrite a plan', async () => {
        const r = await request('POST', `${BASE}/plan/p1/edit`,
            { session_id: 's-alice', plan: { steps: [] } }, BOB);
        expect(r.status).toBe(403);
        expect(mockUpdatePlanInSession).not.toHaveBeenCalled();
    });

    test('another user cannot read the title', async () => {
        const r = await request('GET', `${BASE}/get-session-title?session_id=s-alice`, null, BOB);
        expect(r.status).toBe(403);
        expect(mockGetSessionTitle).not.toHaveBeenCalled();
    });

    test('another user cannot list the session\'s workflow watches', async () => {
        const r = await request('GET', `${BASE}/session/s-alice/workflow-watches`, null, BOB);
        expect(r.status).toBe(403);
        expect(mockWatchFind).not.toHaveBeenCalled();
    });

    test('a repeated session_id query parameter is rejected', async () => {
        const r = await request('GET',
            `${BASE}/get-session-title?session_id=s-new&session_id=s-alice`, null, BOB);
        expect(r.status).toBe(400);
    });

    test.each([
        ['POST', '/answer-questions', { answers: ['a'], original_query: 'q' }],
        ['POST', '/plan/p1/approve', { plan: { steps: [{}] } }],
        ['POST', '/plan/p1/execute-next', {}],
        ['POST', '/plan/p1/skip-step/s1', {}],
        ['POST', '/register-session', {}],
        ['POST', '/add-workflow-to-session', { workflow_id: 'w' }],
        ['POST', '/update-session-title', { title: 't' }],
        ['POST', '/update-session-execution-mode', { execution_mode: 'execute' }],
        ['POST', '/delete-session', {}],
        ['POST', '/rate-conversation', { rating: 5 }],
        ['GET', '/get-session-messages?session_id=s-alice', null],
        ['GET', '/get-session-files?session_id=s-alice', null],
    ])('%s %s is 403 for another user', async (method, path, body) => {
        const payload = body ? { ...body, session_id: 's-alice' } : null;
        const r = await request(method, `${BASE}${path}`, payload, BOB);
        expect(r.status).toBe(403);
    });
});

describe('POST /job/:jobId/abort', () => {
    test('owner can stop their turn', async () => {
        mockGetSessionIdForActiveJob.mockResolvedValueOnce('s-alice');
        const r = await request('POST', `${BASE}/job/j1/abort`, {});
        expect(r.status).toBe(202);
        expect(mockSetCancelFlag).toHaveBeenCalledWith('j1');
    });

    test('another user cannot stop it', async () => {
        mockGetSessionIdForActiveJob.mockResolvedValueOnce('s-alice');
        const r = await request('POST', `${BASE}/job/j1/abort`, {}, BOB);
        expect(r.status).toBe(403);
        expect(mockSetCancelFlag).not.toHaveBeenCalled();
    });

    test('a job that is not an active turn still accepts Stop (no-op flag)', async () => {
        const r = await request('POST', `${BASE}/job/j-unknown/abort`, {}, BOB);
        expect(r.status).toBe(202);
    });
});

describe('GET /workflow-watch/:submissionId/status', () => {
    test('owner sees the watch', async () => {
        mockWatchFindOne.mockResolvedValueOnce({ submission_id: 'sub1', session_id: 's-alice', status: 'active' });
        const r = await request('GET', `${BASE}/workflow-watch/sub1/status`);
        expect(r.status).toBe(200);
        expect(r.body.submission_id).toBe('sub1');
    });

    test('another user gets 404, as if it did not exist', async () => {
        mockWatchFindOne.mockResolvedValueOnce({ submission_id: 'sub1', session_id: 's-alice', status: 'active' });
        const r = await request('GET', `${BASE}/workflow-watch/sub1/status`, null, BOB);
        expect(r.status).toBe(404);
    });
});
