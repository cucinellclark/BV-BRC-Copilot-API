/**
 * selectRecentMessages: the token-budgeted history sent to the orchestrator.
 *
 * If the newest message alone exceeded the budget, the loop stopped before
 * selecting anything and the agent got no prior context at all.
 */

jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/dbUtils', () => ({ getChatSession: jest.fn(), getSummaryBySessionId: jest.fn() }));

const { selectRecentMessages } = require('../services/memory/conversationContextService');

const msg = (role, content) => ({ role, content });

test('fits several short messages in order', () => {
    const out = selectRecentMessages([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')], 4000);
    expect(out.map(m => m.content)).toEqual(['a', 'b', 'c']);
});

test('an oversized newest message is clipped, keeping its start and end', () => {
    const long = 'START ' + 'x'.repeat(40000) + ' NEXT STEPS: submit job 2';
    const out = selectRecentMessages([msg('user', 'earlier'), msg('assistant', long)], 1000);
    expect(out).toHaveLength(1);
    expect(out[0].content.startsWith('START ')).toBe(true);
    expect(out[0].content.endsWith('NEXT STEPS: submit job 2')).toBe(true);
    expect(out[0].content).toContain('[middle omitted]');
    expect(out[0].content.length).toBeLessThanOrEqual(1000 * 4 + 40);
});

test('an oversized older message still stops selection (budget respected)', () => {
    const long = 'y'.repeat(40000);
    const out = selectRecentMessages([msg('assistant', long), msg('user', 'newest')], 1000);
    expect(out.map(m => m.content)).toEqual(['newest']);
});
