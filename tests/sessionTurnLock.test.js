/**
 * One chat turn at a time per session (copilot:session_turn:{sessionId}).
 *
 * 2026-10-09: users re-sent messages while a slow turn ran, and one card
 * click became five concurrent turns that submitted five identical jobs.
 */

const { acquireSessionTurn, releaseSessionTurn, getSessionTurnJob, LOCK_KEY_PREFIX } = require('../services/sessionTurnLock');

// Just enough Redis: SET key val PX ms NX, and the compare-and-delete script.
function fakeRedis() {
    const store = new Map();
    return {
        store,
        async set(key, value, px, ms, nx) {
            expect([px, nx]).toEqual(['PX', 'NX']);
            expect(ms).toBeGreaterThan(0);
            if (store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        async get(key) {
            return store.has(key) ? store.get(key) : null;
        },
        async eval(script, numKeys, key, value) {
            if (store.get(key) === value) { store.delete(key); return 1; }
            return 0;
        },
    };
}

describe('session turn lock', () => {
    test('the holder is known from the moment the turn claims the chat', async () => {
        const redis = fakeRedis();
        expect(await getSessionTurnJob(redis, 's1')).toBeNull();
        await acquireSessionTurn(redis, 's1', 'job-a', 1000);
        expect(await getSessionTurnJob(redis, 's1')).toBe('job-a');
        await releaseSessionTurn(redis, 's1', 'job-a');
        expect(await getSessionTurnJob(redis, 's1')).toBeNull();
        expect(await getSessionTurnJob({ get: async () => { throw new Error('down'); } }, 's1')).toBeNull();
    });

    test('second turn in the same session is refused until the first releases', async () => {
        const redis = fakeRedis();
        expect(await acquireSessionTurn(redis, 's1', 'job-a', 1000)).toBe(true);
        expect(await acquireSessionTurn(redis, 's1', 'job-b', 1000)).toBe(false);
        await releaseSessionTurn(redis, 's1', 'job-a');
        expect(await acquireSessionTurn(redis, 's1', 'job-b', 1000)).toBe(true);
    });

    test('five simultaneous turns: exactly one runs', async () => {
        const redis = fakeRedis();
        const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(j => acquireSessionTurn(redis, 's1', j, 1000)));
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('different sessions do not block each other', async () => {
        const redis = fakeRedis();
        expect(await acquireSessionTurn(redis, 's1', 'job-a', 1000)).toBe(true);
        expect(await acquireSessionTurn(redis, 's2', 'job-b', 1000)).toBe(true);
    });

    test('a late release from an old turn does not free a newer turn', async () => {
        const redis = fakeRedis();
        await acquireSessionTurn(redis, 's1', 'job-a', 1000);
        await releaseSessionTurn(redis, 's1', 'job-a');
        await acquireSessionTurn(redis, 's1', 'job-b', 1000);
        await releaseSessionTurn(redis, 's1', 'job-a'); // stale
        expect(redis.store.get(`${LOCK_KEY_PREFIX}s1`)).toBe('job-b');
    });

    test('no session id is always allowed', async () => {
        expect(await acquireSessionTurn(fakeRedis(), null, 'job-a', 1000)).toBe(true);
    });

    test('Redis failure fails open', async () => {
        const broken = { set: async () => { throw new Error('ECONNREFUSED'); } };
        const warn = jest.fn();
        expect(await acquireSessionTurn(broken, 's1', 'job-a', 1000, { warn })).toBe(true);
        expect(warn).toHaveBeenCalled();
    });
});
