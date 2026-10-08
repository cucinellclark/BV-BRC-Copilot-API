/**
 * registerChatSession must match on session_id alone.
 *
 * Every caller sits behind requireSessionOwner, so an existing row belongs
 * to the caller, possibly under a legacy bare user_id ("alice"). Filtering
 * on {session_id, user_id} would upsert a second row for those sessions.
 * The frontend now registers on the first send of any session that is not
 * on the loaded sidebar page, so this path runs for old sessions too.
 */
const mockUpdateOne = jest.fn();
jest.mock('../services/database', () => ({
    connectToDatabase: jest.fn().mockResolvedValue({
        collection: () => ({ updateOne: mockUpdateOne }),
    }),
}));

const { registerChatSession } = require('../services/dbUtils');

beforeEach(() => mockUpdateOne.mockReset());

test('filters on session_id only and sets the owner only on insert', async () => {
    mockUpdateOne.mockResolvedValue({ upsertedCount: 0, matchedCount: 1, modifiedCount: 1 });
    const r = await registerChatSession('s1', 'alice@patricbrc.org', 'New Chat');
    const [filter, update, opts] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ session_id: 's1' });
    expect(update.$setOnInsert.user_id).toBe('alice@patricbrc.org');
    expect(update.$set.user_id).toBeUndefined();
    expect(opts).toEqual({ upsert: true });
    expect(r.created).toBe(false);
});

test('reports created when the row was inserted', async () => {
    mockUpdateOne.mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0, upsertedId: 'x' });
    const r = await registerChatSession('s2', 'alice@patricbrc.org');
    expect(r.created).toBe(true);
});
