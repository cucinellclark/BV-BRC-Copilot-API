/** Unit tests for the execution_mode resolution inside runOrchestratorLoop. */
jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/database', () => ({ connectToDatabase: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/workflowMonitorService', () => ({ registerWorkflowWatch: jest.fn() }));
jest.mock('../services/memory/conversationContextService', () => ({ buildConversationContext: jest.fn(), buildWorkflowAwareHistory: jest.fn() }));
jest.mock('../services/sseUtils', () => ({ emitSSE: jest.fn(), writeSseEvent: jest.fn() }));
const mockGetChatSession = jest.fn();
const mockAddMessages = jest.fn().mockResolvedValue(true);
jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return { ...actual, getChatSession: mockGetChatSession, createChatSession: jest.fn(), addMessagesToSession: mockAddMessages, addWorkflowIdToSession: jest.fn(), getModelData: jest.fn().mockRejectedValue(new Error('no model')) };
});

// Capture the orchestrator request by intercepting axios (non-streaming path).
let lastRequest = null;
jest.mock('axios', () => ({
    post: jest.fn(async (url, body) => { lastRequest = body; throw new Error('stub upstream'); }),
    get: jest.fn(),
}));

const { executeOrchestratorLoop } = require('../services/orchestratorClient');

async function run(opts) {
    lastRequest = null;
    try { await executeOrchestratorLoop({ query: 'q', session_id: 's1', user_id: 'u', model: 'm', ...opts }); } catch (e) { /* stub upstream */ }
    return lastRequest;
}

beforeEach(() => { jest.clearAllMocks(); mockAddMessages.mockResolvedValue(true); });

describe('runOrchestratorLoop execution_mode resolution', () => {
    test('persisted turn reads the session mode', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'execute', messages: [] });
        const req = await run({ execution_mode: 'plan' });
        expect(req.execution_mode).toBe('execute');
    });
    test('missing session mode is plan', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', messages: [] });
        expect((await run({})).execution_mode).toBe('plan');
    });
    test('ephemeral turn uses the request mode', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan', messages: [] });
        expect((await run({ save_chat: false, execution_mode: 'execute' })).execution_mode).toBe('execute');
    });
    test('execute_once overrides a plan session for this turn only', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan', messages: [] });
        const req = await run({ execute_once: true });
        expect(req.execution_mode).toBe('execute');
        // The persisted user message carries the one-shot marker
        const saved = mockAddMessages.mock.calls[0][1][0];
        expect(saved.attachments).toEqual([{ type: 'execution', source: 'once', name: 'Execute mode (this message only)' }]);
    });
    test('no marker without execute_once', async () => {
        mockGetChatSession.mockResolvedValue({ session_id: 's1', execution_mode: 'plan', messages: [] });
        await run({});
        const saved = mockAddMessages.mock.calls[0][1][0];
        expect(saved.attachments).toBeUndefined();
    });
});
