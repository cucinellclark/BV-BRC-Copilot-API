/**
 * runChatTurn refuses a second turn in a session with 409 TURN_IN_FLIGHT
 * before opening SSE, and releases the lock when a turn ends.
 */

const mockRedisSet = jest.fn();
const mockRedisEval = jest.fn();
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(),
    set: mockRedisSet,
    eval: mockRedisEval,
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    zcard: jest.fn().mockResolvedValue(0),
    zrem: jest.fn().mockResolvedValue(1),
})));

const mockExecute = jest.fn();
jest.mock('../services/orchestratorClient', () => ({ executeOrchestratorLoop: (...a) => mockExecute(...a) }));
jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/sseUtils', () => ({ writeSseEvent: jest.fn() }));
jest.mock('../services/queueRedisConfig', () => ({ getQueueRedisConfig: () => ({ host: 'x', port: 1, db: 0 }) }));
jest.mock('../services/sessionStreamRegistry', () => ({ register: jest.fn(), unregister: jest.fn() }));
jest.mock('../services/dbUtils', () => ({
    setSessionActiveJob: jest.fn().mockResolvedValue(null),
    clearSessionActiveJob: jest.fn().mockResolvedValue(null),
}));
jest.mock('../config.json', () => ({ admission: { max_chats: 8 }, orchestrator: { timeout_ms: 600000 } }), { virtual: true });

const { runChatTurn } = require('../services/chatRunner');

function fakeRes() {
    const res = {
        statusCode: 200, body: null, headers: {}, writableEnded: false, destroyed: false,
        status(code) { this.statusCode = code; return this; },
        json(b) { this.body = b; this.writableEnded = true; return this; },
        set(h) { Object.assign(this.headers, h); },
        flushHeaders() {}, write() {}, end() { this.writableEnded = true; },
        on() {},
    };
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisEval.mockResolvedValue(1); // slot acquire + lock release both succeed
});

test('a held session gets 409 TURN_IN_FLIGHT and no orchestrator call', async () => {
    mockRedisSet.mockResolvedValue(null); // SET NX lost: another turn holds it
    const res = fakeRes();
    await runChatTurn({}, res, { session_id: 's1', query: 'q' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TURN_IN_FLIGHT');
    expect(mockExecute).not.toHaveBeenCalled();
});

test('a free session runs the turn and releases the lock afterwards', async () => {
    mockRedisSet.mockResolvedValue('OK');
    mockExecute.mockResolvedValue({});
    const res = fakeRes();
    await runChatTurn({}, res, { session_id: 's1', query: 'q' });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const lockCall = mockRedisSet.mock.calls.find(c => c[0] === 'copilot:session_turn:s1');
    expect(lockCall).toBeTruthy();
    const jobId = lockCall[1];
    const release = mockRedisEval.mock.calls.find(c => c[2] === 'copilot:session_turn:s1');
    expect(release && release[3]).toBe(jobId);
});
