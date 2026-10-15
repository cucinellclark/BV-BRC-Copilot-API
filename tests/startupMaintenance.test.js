/**
 * Startup / periodic maintenance (startupMaintenance.js) and the monitor
 * dropping a user's token once their job finishes.
 *
 * Found 2026-10-15 in the live database: all 190 workflow watches still held
 * the user's BV-BRC token (none active), one chat had shown as busy since
 * Sep 18 (a crashed gateway's active_job_id), and both collections had no
 * index but _id.
 */

jest.mock('bull', () => jest.fn().mockImplementation(() => ({ process: jest.fn(), add: jest.fn(), on: jest.fn() })));
jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/database', () => ({ connectToDatabase: jest.fn() }));
jest.mock('../services/dbUtils', () => ({ addMessagesToSession: jest.fn(), getChatSession: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/sessionStreamRegistry', () => ({ pushToSession: jest.fn() }));
jest.mock('../services/queueRedisConfig', () => ({ getQueueRedisConfig: () => ({ host: 'x', port: 1, db: 0 }) }));
jest.mock('../config.json', () => ({
    workflow_monitor: { enabled: false, max_watch_age_hours: 72 },
    admission: { wait_ms: 300000 },
    orchestrator: { timeout_ms: 600000 },
}), { virtual: true });
jest.mock('axios');

const axios = require('axios');
const {
    clearStaleActiveJobs, purgeWatchTokens, ensureIndexes, maxTurnMs, INDEXES,
} = require('../services/startupMaintenance');
const { checkAndHandleWorkflow } = require('../services/workflowMonitorService');

// ---------------------------------------------------------------------------
// A collection that applies the few Mongo operators these filters use.
// ---------------------------------------------------------------------------
function matches(doc, filter) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === '$or') return cond.some((f) => matches(doc, f));
        const value = doc[key];
        if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            return Object.entries(cond).every(([op, arg]) => {
                if (op === '$exists') return (value !== undefined) === arg;
                if (op === '$lt') return value !== undefined && value < arg;
                if (op === '$ne') return value !== arg;
                throw new Error(`unsupported ${op}`);
            });
        }
        return value === cond;
    });
}

function apply(doc, update) {
    Object.assign(doc, update.$set || {});
    Object.keys(update.$unset || {}).forEach((k) => { delete doc[k]; });
}

function fakeCollection(docs) {
    return {
        docs,
        indexes: [],
        async updateMany(filter, update) {
            const hit = docs.filter((d) => matches(d, filter));
            hit.forEach((d) => apply(d, update));
            return { modifiedCount: hit.length };
        },
        async updateOne(filter, update) {
            const hit = docs.find((d) => matches(d, filter));
            if (hit) apply(hit, update);
            return { matchedCount: hit ? 1 : 0 };
        },
        async createIndexes(specs) { this.indexes.push(...specs); },
    };
}

function fakeDb(collections) {
    return { collection: (name) => collections[name] };
}

const NOW = Date.parse('2026-10-15T12:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60000);

// ---------------------------------------------------------------------------

describe('stale busy flags (active_job_id)', () => {
    test('only flags older than the longest possible turn are cleared', async () => {
        expect(maxTurnMs()).toBe(16 * 60000);
        const sessions = fakeCollection([
            { session_id: 'crashed', active_job_id: 'j1', active_job_started_at: minutesAgo(30) },
            // A turn on the other gateway (same database), still running
            { session_id: 'live', active_job_id: 'j2', active_job_started_at: minutesAgo(5) },
            // Set before active_job_started_at existed: last_modified decides
            { session_id: 'legacy', active_job_id: 'j3', last_modified: new Date('2026-09-18T16:38:44Z') },
            { session_id: 'legacy-recent', active_job_id: 'j4', last_modified: minutesAgo(2) },
            { session_id: 'idle', last_modified: minutesAgo(600) },
        ]);
        const n = await clearStaleActiveJobs(fakeDb({ chat_sessions: sessions }), NOW);
        expect(n).toBe(2);
        const busy = sessions.docs.filter((d) => d.active_job_id).map((d) => d.session_id);
        expect(busy).toEqual(['live', 'legacy-recent']);
        expect(sessions.docs[0].active_job_started_at).toBeUndefined();
    });
});

describe('user tokens on workflow watches', () => {
    test('finished watches lose the token; old active ones expire; running ones keep it', async () => {
        const watches = fakeCollection([
            { submission_id: 'done', status: 'completed', auth_token: 'tok' },
            { submission_id: 'failed', status: 'failed', auth_token: 'tok' },
            { submission_id: 'running', status: 'active', created_at: minutesAgo(60), auth_token: 'tok' },
            { submission_id: 'abandoned', status: 'active', created_at: minutesAgo(73 * 60), auth_token: 'tok' },
        ]);
        const out = await purgeWatchTokens(fakeDb({ workflow_watches: watches }), NOW);
        expect(out).toEqual({ expired: 1, tokensRemoved: 2 });
        const byId = Object.fromEntries(watches.docs.map((d) => [d.submission_id, d]));
        expect(byId.running.auth_token).toBe('tok');
        expect(byId.abandoned.status).toBe('expired');
        ['done', 'failed', 'abandoned'].forEach((id) => expect(byId[id].auth_token).toBeUndefined());
    });

    test('the monitor drops the token the moment the job finishes', async () => {
        axios.get.mockResolvedValueOnce({ data: { status: 'ok', data: { state: 'COMPLETED', inputs: {} } } });
        const watches = fakeCollection([
            { _id: 1, submission_id: 'sub1', session_id: 's1', status: 'active', auth_token: 'tok' },
        ]);
        await checkAndHandleWorkflow(watches.docs[0], watches);
        expect(watches.docs[0].status).toBe('completed');
        expect(watches.docs[0].auth_token).toBeUndefined();
    });

    test('a running job keeps its token', async () => {
        axios.get.mockResolvedValueOnce({ data: { status: 'ok', data: { state: 'RUNNING' } } });
        const watches = fakeCollection([
            { _id: 1, submission_id: 'sub1', session_id: 's1', status: 'active', auth_token: 'tok' },
        ]);
        await checkAndHandleWorkflow(watches.docs[0], watches);
        expect(watches.docs[0].auth_token).toBe('tok');
    });
});

describe('indexes', () => {
    test('session, sidebar and watch lookups are indexed', async () => {
        const cols = { chat_sessions: fakeCollection([]), workflow_watches: fakeCollection([]) };
        await ensureIndexes(fakeDb(cols));
        const keys = (c) => cols[c].indexes.map((i) => JSON.stringify(i.key));
        expect(keys('chat_sessions')).toEqual(expect.arrayContaining([
            '{"session_id":1}', '{"user_id":1,"last_modified":-1}', '{"active_job_id":1}']));
        expect(keys('workflow_watches')).toEqual(expect.arrayContaining([
            '{"submission_id":1}', '{"status":1,"created_at":1}']));
        // Not unique: the live data has duplicate session_id and submission_id rows.
        Object.values(INDEXES).flat().forEach((spec) => expect(spec.unique).toBeUndefined());
    });

    test('an index failure is logged, not thrown', async () => {
        const bad = { createIndexes: async () => { throw new Error('no permission'); } };
        await expect(ensureIndexes(fakeDb({ chat_sessions: bad, workflow_watches: bad }))).resolves.toBeUndefined();
    });
});
