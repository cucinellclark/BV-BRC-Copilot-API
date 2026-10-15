/**
 * Deleting a chat archives it (2026-10-15, Clark): the chat disappears for the
 * user -- gone from the list, and any session route answers 404
 * SESSION_ARCHIVED -- but the document stays for the team.  Kept indefinitely.
 */

const docs = [];
function matches(doc, filter) {
    return Object.entries(filter).every(([k, v]) => {
        if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
        return doc[k] === v;
    });
}
const collection = {
    async updateMany(filter, update) {
        const hit = docs.filter((d) => matches(d, filter));
        hit.forEach((d) => { Object.assign(d, update.$set); Object.keys(update.$unset || {}).forEach((k) => delete d[k]); });
        return { modifiedCount: hit.length };
    },
    async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
    find(filter) {
        const rows = docs.filter((d) => matches(d, filter));
        const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, toArray: async () => rows };
        return cursor;
    },
};
jest.mock('../services/database', () => ({ connectToDatabase: async () => ({ collection: () => collection }) }));
jest.mock('../config.json', () => ({}), { virtual: true });

const { deleteSession, getUserSessions, isSessionArchived } = require('../services/dbUtils');

beforeEach(() => {
    docs.length = 0;
    docs.push(
        { session_id: 's1', user_id: 'alice@patricbrc.org', title: 'keep me', active_job_id: 'j1' },
        { session_id: 's2', user_id: 'alice@patricbrc.org', title: 'other' },
    );
});

test('delete archives the chat instead of removing it', async () => {
    const r = await deleteSession('s1', 'alice@patricbrc.org');
    expect(r.deletedCount).toBe(1);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ session_id: 's1', archived: true, title: 'keep me' });
    expect(docs[0].archived_at).toBeInstanceOf(Date);
    expect(docs[0].active_job_id).toBeUndefined();
});

test('deleting twice, or another user\'s chat, reports nothing deleted', async () => {
    await deleteSession('s1', 'alice@patricbrc.org');
    expect((await deleteSession('s1', 'alice@patricbrc.org')).deletedCount).toBe(0);
    expect((await deleteSession('s2', 'bob@patricbrc.org')).deletedCount).toBe(0);
});

test('archived chats leave the list and are reported as archived', async () => {
    await deleteSession('s1', 'alice@patricbrc.org');
    const { sessions, total } = await getUserSessions('alice@patricbrc.org');
    expect(sessions.map((s) => s.session_id)).toEqual(['s2']);
    expect(total).toBe(1);
    expect(await isSessionArchived('s1')).toBe(true);
    expect(await isSessionArchived('s2')).toBe(false);
});
