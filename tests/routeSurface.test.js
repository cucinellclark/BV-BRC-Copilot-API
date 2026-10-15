/**
 * Attack surface of the gateway routes.
 *
 *  - Removed routes stay removed: legacy chat paths, the open /chat-only
 *    LLM relay, the unauthenticated /workflow-complete message writer,
 *    /rag-chunk-search (cross-user search), /mcp/replay-tool-call,
 *    /submit-workflow/:id.
 *  - /db/get-model-list returns only display fields: no apiKey, endpoint,
 *    queryType, or RAG rag_endpoint / filesystem paths.
 *
 * Mocks MongoDB access so no database is needed.
 */

const express = require('express');
const http = require('http');

const mockGetActiveModels = jest.fn();
const mockGetActiveRagDatabases = jest.fn();

jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return {
        ...actual,
    isSessionArchived: jest.fn().mockResolvedValue(false),
        getActiveModels: mockGetActiveModels,
        getActiveRagDatabases: mockGetActiveRagDatabases,
        getSessionOwnerIds: jest.fn().mockResolvedValue([]),
        getSessionIdForActiveJob: jest.fn().mockResolvedValue(null),
        getChatSession: jest.fn().mockResolvedValue(null),
    };
});

jest.mock('../services/database', () => ({ connectToDatabase: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/mcp/mcpExecutor', () => ({ executeMcpTool: jest.fn(), isReplayableTool: jest.fn() }));
jest.mock('../services/logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../services/chatService', () => ({}));
jest.mock('../middleware/auth', () => ({
    requireAuth: (req, res, next) => { req.user = 'alice@patricbrc.org'; next(); },
    resolveUserId: (req) => ({ userId: req.user }),
}));
jest.mock('../prompts', () => ({}));
jest.mock('../services/sseUtils', () => ({ writeSseEvent: jest.fn(), emitSSE: jest.fn() }));
jest.mock('../config.json', () => ({}), { virtual: true });
jest.mock('../services/chatRunner', () => ({ runChatTurn: jest.fn(), setCancelFlag: jest.fn(), releaseSessionTurnForJob: jest.fn() }));
jest.mock('../services/sessionStreamRegistry', () => ({
    register: jest.fn(), unregister: jest.fn(), pushToSession: jest.fn(),
}));
jest.mock('../services/workflowMonitorService', () => ({ registerWorkflowWatch: jest.fn() }));
jest.mock('../services/memory/conversationContextService', () => ({
    buildConversationContext: jest.fn(), buildWorkflowAwareHistory: jest.fn(),
}));

let request;
let server;

beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use('/copilot-api/chatbrc', require('../routes/chatRoutes'));
    app.use('/copilot-api/db', require('../routes/dbRoutes'));
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

describe('removed routes', () => {
    test.each([
        ['POST', '/copilot-api/chatbrc/copilot'],
        ['POST', '/copilot-api/chatbrc/chat'],
        ['POST', '/copilot-api/chatbrc/chat-only'],
        ['POST', '/copilot-api/chatbrc/demo'],
        ['POST', '/copilot-api/chatbrc/setup-copilot-stream'],
        ['POST', '/copilot-api/chatbrc/copilot-stream'],
        ['POST', '/copilot-api/chatbrc/mcp/replay-tool-call'],
        ['POST', '/copilot-api/chatbrc/submit-workflow/w1'],
        ['POST', '/copilot-api/chatbrc/workflow-complete'],
        ['GET', '/copilot-api/chatbrc/rag-chunk-search?session_id=s1'],
    ])('%s %s is 404', async (method, path) => {
        const r = await request(method, path, method === 'POST' ? { session_id: 's1' } : null);
        expect(r.status).toBe(404);
    });
});

describe('POST /db/get-model-list', () => {
    beforeEach(() => {
        mockGetActiveModels.mockResolvedValue([{
            _id: 'x', model: 'Qwen/Qwen3.6-35B-A3B', model_type: 'chat', active: true,
            priority: 1, max_tokens: 40000, supports_image: true, is_default: true,
            endpoint: 'http://mango.cels.anl.gov:8004/v1', apiKey: 'sk-secret', queryType: 'request',
        }]);
        mockGetActiveRagDatabases.mockResolvedValue([{
            _id: 'y', name: 'bvbrc_helpdesk', active: true, priority: 1, model: 'm',
            rag_endpoint: 'http://internal/rag', apiKey: 'rag-secret', queryType: 'q',
            program: 'p', data: { faiss_index_path: '/vol/secret/index' },
        }]);
    });

    test('returns display fields only', async () => {
        const r = await request('POST', '/copilot-api/db/get-model-list', { project_id: 'test' });
        expect(r.status).toBe(200);
        const models = JSON.parse(r.body.models);
        const rags = JSON.parse(r.body.vdb_list);
        expect(models).toEqual([{
            model: 'Qwen/Qwen3.6-35B-A3B', model_type: 'chat', active: true,
            priority: 1, max_tokens: 40000, supports_image: true, is_default: true,
        }]);
        expect(rags).toEqual([{ name: 'bvbrc_helpdesk', active: true, priority: 1 }]);
        const raw = JSON.stringify(r.body);
        for (const leaked of ['sk-secret', 'rag-secret', 'mango.cels', 'internal/rag', '/vol/secret']) {
            expect(raw).not.toContain(leaked);
        }
    });

    test('a database error is a generic 500', async () => {
        mockGetActiveModels.mockRejectedValueOnce(new Error('connect ECONNREFUSED 140.221.78.16:27018'));
        const r = await request('POST', '/copilot-api/db/get-model-list', {});
        expect(r.status).toBe(500);
        expect(JSON.stringify(r.body)).not.toContain('140.221');
    });
});
