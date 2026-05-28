/**
 * Tests for POST /copilot-api/chatbrc/workflow-complete webhook endpoint.
 *
 * Mocks MongoDB access (dbUtils) so no database is needed.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Mock dbUtils BEFORE requiring chatRoutes (which imports them at load time)
// ---------------------------------------------------------------------------
const mockGetChatSession = jest.fn();
const mockAddMessagesToSession = jest.fn();

jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return {
        ...actual,
        getChatSession: mockGetChatSession,
        addMessagesToSession: mockAddMessagesToSession,
        // Stubs for other imports that chatRoutes pulls in at load time
        getModelData: jest.fn(),
        getSessionMessages: jest.fn(),
        getSessionTitle: jest.fn(),
        getUserSessions: jest.fn(),
        updateSessionTitle: jest.fn(),
        deleteSession: jest.fn(),
        getUserPrompts: jest.fn(),
        saveUserPrompt: jest.fn(),
        registerChatSession: jest.fn(),
        addWorkflowIdToSession: jest.fn(),
        rateConversation: jest.fn(),
        rateMessage: jest.fn(),
        getSessionFilesPaginated: jest.fn(),
        getSessionStorageSize: jest.fn(),
        getUserWorkflowIds: jest.fn(),
        searchRagChunkReferences: jest.fn(),
    };
});

// Mock queueService to prevent Redis connection at import time
jest.mock('../services/queueService', () => ({
    addAgentJob: jest.fn(),
    getJobStatus: jest.fn(),
    getQueueStats: jest.fn(),
    registerStreamCallback: jest.fn(),
    abortJob: jest.fn(),
}));

// Mock ragQueueService similarly
jest.mock('../services/ragQueueService', () => ({
    addRagJob: jest.fn(),
    getRagJobStatus: jest.fn(),
    getRagQueueStats: jest.fn(),
    registerRagStreamCallback: jest.fn(),
    abortRagJob: jest.fn(),
}));

// Mock MCP executor
jest.mock('../services/mcp/mcpExecutor', () => ({
    executeMcpTool: jest.fn(),
    isReplayableTool: jest.fn(),
}));

// Mock logger
jest.mock('../services/logger', () => ({
    createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Mock database (connectToDatabase)
jest.mock('../services/database', () => ({
    connectToDatabase: jest.fn().mockResolvedValue({}),
}));

// Mock chatService
jest.mock('../services/chatService', () => ({}));

// Mock agentOrchestrator
jest.mock('../services/agentOrchestrator', () => ({}));

// Mock auth middleware to be a no-op
jest.mock('../middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    resolveUserId: (req, res, next) => next(),
}));

// Mock prompts
jest.mock('../prompts', () => ({}));

// Mock sseUtils
jest.mock('../services/sseUtils', () => ({
    writeSseEvent: jest.fn(),
}));

// Mock config.json
jest.mock('../config.json', () => ({}), { virtual: true });

// Mock orchestratorClient to avoid import-time side effects
jest.mock('../services/orchestratorClient', () => ({
    executeOrchestratorLoop: jest.fn(),
    streamFromOrchestrator: jest.fn(),
    checkOrchestratorHealth: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Now require the router & set up the test app
// ---------------------------------------------------------------------------
let app;
let request;

beforeAll(async () => {
    // Dynamically import supertest-like helper via http
    const chatRoutes = require('../routes/chatRoutes');
    app = express();
    app.use(express.json());
    app.use('/copilot-api/chatbrc', chatRoutes);

    // Use Node's built-in http to create a test helper
    const http = require('http');
    const server = http.createServer(app);

    // Simple test helper using native http
    request = (method, path, body) => {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : '';
            const options = {
                method,
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            };

            const req = http.request(server.address(), options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    let json;
                    try { json = JSON.parse(responseData); } catch (e) { json = null; }
                    resolve({ status: res.statusCode, body: json, text: responseData });
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    };

    await new Promise((resolve) => server.listen(0, resolve));
    const addr = server.address();
    // Override request to include host/port
    const port = addr.port;
    request = (method, path, body) => {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : '';
            const options = {
                hostname: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            };

            const req = http.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    let json;
                    try { json = JSON.parse(responseData); } catch (e) { json = null; }
                    resolve({ status: res.statusCode, body: json, text: responseData });
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    };

    // Store server reference for cleanup
    app._testServer = server;
});

afterAll((done) => {
    if (app && app._testServer) {
        app._testServer.close(done);
    } else {
        done();
    }
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: valid payload
// ---------------------------------------------------------------------------
function validPayload(overrides = {}) {
    return {
        workflow_id: 'wf-test-001',
        workflow_name: 'Genome Assembly Pipeline',
        status: 'succeeded',
        session_id: 'session-abc-123',
        owner: 'testuser@bvbrc.org',
        completed_at: new Date().toISOString(),
        steps: [
            {
                step_name: 'assemble',
                app: 'GenomeAssembly2',
                status: 'succeeded',
                elapsed_time: '00:15:30',
                error_message: null,
            },
            {
                step_name: 'annotate',
                app: 'GenomeAnnotation',
                status: 'succeeded',
                elapsed_time: '00:10:00',
                error_message: null,
            },
        ],
        output_paths: [
            '/testuser@bvbrc.org/output/contigs.fasta',
            '/testuser@bvbrc.org/output/genome.gto',
        ],
        auth_token: 'secret-jwt-token',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /copilot-api/chatbrc/workflow-complete', () => {
    test('writes completion message to MongoDB on valid succeeded payload', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 'session-abc-123', messages: [] });
        mockAddMessagesToSession.mockResolvedValue({ modifiedCount: 1 });

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', validPayload());

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        // Verify addMessagesToSession was called
        expect(mockAddMessagesToSession).toHaveBeenCalledTimes(1);
        const [sessionId, messages] = mockAddMessagesToSession.mock.calls[0];
        expect(sessionId).toBe('session-abc-123');
        expect(messages).toHaveLength(1);

        const msg = messages[0];
        expect(msg.role).toBe('assistant');
        expect(msg.message_id).toBeDefined();
        expect(msg.timestamp).toBeDefined();
        expect(msg.content).toContain('completed successfully');
        expect(msg.content).toContain('Genome Assembly Pipeline');
        expect(msg.content).toContain('assemble');
        expect(msg.content).toContain('annotate');
        expect(msg.content).toContain('contigs.fasta');

        // Verify metadata
        expect(msg.agent_metadata.system_initiated).toBe(true);
        expect(msg.agent_metadata.trigger).toBe('workflow_complete');
        expect(msg.agent_metadata.workflow_id).toBe('wf-test-001');

        // Verify workflow field
        expect(msg.workflow.workflow_id).toBe('wf-test-001');
        expect(msg.workflow.status).toBe('succeeded');
        expect(msg.workflow.steps).toHaveLength(2);
    });

    test('returns 400 when workflow_id is missing', async () => {
        const payload = validPayload();
        delete payload.workflow_id;

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', payload);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('workflow_id');
        expect(mockAddMessagesToSession).not.toHaveBeenCalled();
    });

    test('returns 400 when session_id is missing', async () => {
        const payload = validPayload();
        delete payload.session_id;

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', payload);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('session_id');
        expect(mockAddMessagesToSession).not.toHaveBeenCalled();
    });

    test('returns 404 when session does not exist', async () => {
        mockGetChatSession.mockResolvedValue(null);

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', validPayload());

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
        expect(mockAddMessagesToSession).not.toHaveBeenCalled();
    });

    test('writes failure message with error details', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 'session-abc-123' });
        mockAddMessagesToSession.mockResolvedValue({ modifiedCount: 1 });

        const payload = validPayload({
            status: 'failed',
            steps: [
                {
                    step_name: 'assemble',
                    app: 'GenomeAssembly2',
                    status: 'succeeded',
                    elapsed_time: '00:15:30',
                    error_message: null,
                },
                {
                    step_name: 'annotate',
                    app: 'GenomeAnnotation',
                    status: 'failed',
                    elapsed_time: null,
                    error_message: 'Invalid genome format',
                },
            ],
        });

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', payload);

        expect(res.status).toBe(200);
        const msg = mockAddMessagesToSession.mock.calls[0][1][0];
        expect(msg.content).toContain('has failed');
        expect(msg.content).toContain('annotate');
        expect(msg.content).toContain('Invalid genome format');
        expect(msg.content).toContain('assemble');  // completed steps mentioned
    });

    test('writes cancellation message', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 'session-abc-123' });
        mockAddMessagesToSession.mockResolvedValue({ modifiedCount: 1 });

        const payload = validPayload({ status: 'cancelled' });

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', payload);

        expect(res.status).toBe(200);
        const msg = mockAddMessagesToSession.mock.calls[0][1][0];
        expect(msg.content).toContain('was cancelled');
    });

    test('returns 500 when MongoDB write fails', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 'session-abc-123' });
        mockAddMessagesToSession.mockRejectedValue(new Error('MongoDB connection lost'));

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', validPayload());

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('Internal server error');
    });

    test('does not log auth_token in message document', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 'session-abc-123' });
        mockAddMessagesToSession.mockResolvedValue({ modifiedCount: 1 });

        const res = await request('POST', '/copilot-api/chatbrc/workflow-complete', validPayload());

        expect(res.status).toBe(200);
        const msg = mockAddMessagesToSession.mock.calls[0][1][0];
        // The message content should not contain the auth token
        expect(msg.content).not.toContain('secret-jwt-token');
        // The message document itself should not have auth_token
        expect(msg.auth_token).toBeUndefined();
    });
});
