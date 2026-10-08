/**
 * What gets saved when a turn does not finish normally, or when the
 * session row does not exist yet (a new user's first chat).
 *
 *  - Stop with partial text: the text is kept and marked "_Stopped._"
 *  - Stop before any text (common with thinking models): a short
 *    "Stopped before a response was ready" note, not an empty bubble
 *  - The orchestrator connection drops: a plain-language message, not
 *    "error connecting to the backend"
 */
const { PassThrough } = require('stream');

jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/database', () => ({ connectToDatabase: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/workflowMonitorService', () => ({ registerWorkflowWatch: jest.fn() }));
jest.mock('../services/memory/conversationContextService', () => ({ buildConversationContext: jest.fn(), buildWorkflowAwareHistory: jest.fn() }));
jest.mock('../services/sseUtils', () => ({ emitSSE: jest.fn(), writeSseEvent: jest.fn() }));
jest.mock('../services/internalKey', () => ({ internalKeyHeaders: () => ({}) }));

const mockAddMessages = jest.fn();
const mockGetChatSession = jest.fn();
const mockRegisterChatSession = jest.fn();
jest.mock('../services/dbUtils', () => {
    const actual = jest.requireActual('../services/dbUtils');
    return {
        ...actual,
        getChatSession: mockGetChatSession,
        registerChatSession: mockRegisterChatSession,
        addMessagesToSession: mockAddMessages,
        addWorkflowIdToSession: jest.fn(),
        getModelData: jest.fn().mockRejectedValue(new Error('no model')),
    };
});

const mockPost = jest.fn();
jest.mock('axios', () => ({ post: (...args) => mockPost(...args) }));

const { executeOrchestratorLoop } = require('../services/orchestratorClient');

function sseFrame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify({ id: 'e', type, data, agent_name: 'data' })}\n\n`;
}

async function runTurn({ shouldCancel }) {
    const res = { write: jest.fn(), flush: jest.fn(), on: jest.fn() };
    await executeOrchestratorLoop({
        query: 'how many E. coli genomes?', session_id: 's1', user_id: 'u', model: 'm',
        stream: true, responseStream: res, shouldCancel,
    });
    const saved = mockAddMessages.mock.calls.flatMap((c) => c[1]);
    return saved.filter((m) => m.role === 'assistant').pop();
}

const EXISTING = { session_id: 's1', user_id: 'u', execution_mode: 'plan', messages: [] };

beforeEach(() => {
    mockAddMessages.mockReset();
    mockAddMessages.mockResolvedValue({ matchedCount: 1 });
    mockGetChatSession.mockReset();
    mockGetChatSession.mockResolvedValue(EXISTING);
    mockRegisterChatSession.mockReset();
    mockRegisterChatSession.mockResolvedValue({ created: true });
    mockPost.mockReset();
});

function savedRoles() {
    return mockAddMessages.mock.calls.map((c) => c[1].map((m) => m.role));
}

test('Stop after partial text keeps the text and marks it stopped', async () => {
    const body = new PassThrough();
    mockPost.mockResolvedValue({ data: body });
    let sent = false;
    const msg = await runTurn({
        shouldCancel: () => {
            if (!sent) {
                body.write(sseFrame('synthesis_chunk', { chunk: 'Found 4,932 genomes so far' }));
                sent = true;
                return false;
            }
            return true;
        },
    });
    expect(msg.content).toMatch(/^Found 4,932 genomes so far/);
    expect(msg.content).toMatch(/_Stopped\._$/);
});

test('Stop before any text saves a note, not an empty bubble', async () => {
    mockPost.mockResolvedValue({ data: new PassThrough() });
    const msg = await runTurn({ shouldCancel: () => true });
    expect(msg.content).toBe('_Stopped before a response was ready._');
});

test('A dropped orchestrator connection is explained in plain language', async () => {
    mockPost.mockRejectedValue(new Error('socket hang up'));
    const msg = await runTurn({ shouldCancel: () => false });
    expect(msg.content).toMatch(/stopped responding before it finished/);
    expect(msg.content).not.toMatch(/error connecting to the backend/);
});

describe('first message of a new session', () => {
    test('a missing session row is created with the idempotent upsert', async () => {
        mockGetChatSession.mockResolvedValueOnce(null).mockResolvedValue(EXISTING);
        mockPost.mockRejectedValue(new Error('stub upstream'));
        await runTurn({ shouldCancel: () => false });
        expect(mockRegisterChatSession).toHaveBeenCalledWith('s1', 'u', 'Untitled');
    });

    test('if the early save matched nothing, the final save includes the user message', async () => {
        mockAddMessages
            .mockResolvedValueOnce({ matchedCount: 0 })   // early user-message push
            .mockResolvedValue({ matchedCount: 1 });      // final save
        mockPost.mockRejectedValue(new Error('stub upstream'));
        await runTurn({ shouldCancel: () => false });
        expect(savedRoles()).toEqual([['user'], ['user', 'assistant']]);
    });

    test('a successful early save is not duplicated', async () => {
        mockPost.mockRejectedValue(new Error('stub upstream'));
        await runTurn({ shouldCancel: () => false });
        expect(savedRoles()).toEqual([['user'], ['assistant']]);
    });
});
