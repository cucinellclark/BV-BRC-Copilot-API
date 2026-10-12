/**
 * Workflow completion messages.
 *
 * Every completion message in the Sep codeathon and on Oct 9 read "Results
 * are available in your workspace at your workspace.": GoWe returns no
 * output_paths and no top-level output_path; the folder is inputs.output_path.
 * Failure messages also showed raw Perl stack traces (nbowers, Oct 9).
 */

jest.mock('bull', () => jest.fn().mockImplementation(() => ({ process: jest.fn(), add: jest.fn(), on: jest.fn() })));
jest.mock('../services/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../services/database', () => ({ connectToDatabase: jest.fn() }));
jest.mock('../services/dbUtils', () => ({ addMessagesToSession: jest.fn(), getChatSession: jest.fn() }));
jest.mock('../services/sessionStreamRegistry', () => ({ pushToSession: jest.fn() }));
jest.mock('../services/queueRedisConfig', () => ({ getQueueRedisConfig: () => ({ host: 'x', port: 1, db: 0 }) }));
jest.mock('../config.json', () => ({ workflow_monitor: { enabled: false } }), { virtual: true });

const { buildCompletionMessage, resolveOutputPaths, cleanStderr } = require('../services/workflowMonitorService');

const OUT = '/clark.cucinell@patricbrc.org/home/chats/53dc1802/ComparativeSystems_ecoli_small';

describe('resolveOutputPaths', () => {
    test('uses inputs.output_path, which is what GoWe actually returns', () => {
        expect(resolveOutputPaths({ state: 'COMPLETED', inputs: { output_path: OUT } })).toEqual([OUT]);
    });
    test('prefers output_paths when GoWe provides them', () => {
        expect(resolveOutputPaths({ output_paths: ['/a', '/b'], inputs: { output_path: OUT } })).toEqual(['/a', '/b']);
    });
    test('nothing known -> empty', () => {
        expect(resolveOutputPaths({ inputs: {} })).toEqual([]);
        expect(resolveOutputPaths(null)).toEqual([]);
    });
});

describe('buildCompletionMessage', () => {
    test('success names the folder and links it, no "at your workspace"', () => {
        const msg = buildCompletionMessage('completed', 'Comparative Systems', [], [OUT], [{ external_id: '23731614' }], null);
        expect(msg).toContain(`\`${OUT}\``);
        expect(msg).toContain('(<https://www.bv-brc.org/workspace/clark.cucinell@patricbrc.org/home/chats/53dc1802/ComparativeSystems_ecoli_small>)');
        expect(msg).toContain('Job ID: 23731614');
        expect(msg).not.toMatch(/at your workspace/);
    });
    test('folder names with spaces are encoded in the link only', () => {
        const msg = buildCompletionMessage('completed', 'X', [], ['/u@p/home/My Runs/a'], [], null);
        expect(msg).toContain('`/u@p/home/My Runs/a`');
        expect(msg).toContain('workspace/u@p/home/My%20Runs/a>');
    });
    test('success with no known folder points to the Jobs list', () => {
        const msg = buildCompletionMessage('completed', 'X', [], [], [], null);
        expect(msg).toContain('Results are in your workspace (see the Jobs list).');
        expect(msg).not.toMatch(/at your workspace/);
    });
    test('a failed step message that is a Perl trace is cleaned', () => {
        const trace = [
            'Failed to run snpEff: database not found for 224914.11 at /opt/bvbrc/lib/Bio/P3/Variation.pm line 412.',
            '\tBio::P3::Variation::run_snpeff(\'x\') called at /opt/bvbrc/bin/App-Variation line 88',
            'main::process(HASH(0x5581)) called at /opt/bvbrc/bin/App-Variation line 40',
        ].join('\n');
        const msg = buildCompletionMessage('failed', 'Variation', [{ step_name: 'run_tool', app: 'Variation', status: 'failed', error_message: trace }], [], [], null);
        expect(msg).toContain('Failed to run snpEff: database not found for 224914.11.');
        expect(msg).not.toMatch(/called at|line 412|HASH\(/);
    });
    test('submission stderr is used when there is no step error', () => {
        const msg = buildCompletionMessage('failed', 'CGA', [], [], [], { message: 'step failed', context: { stderr: 'loading\nERROR: taxonomy_id is required at /x/App.pm line 9.' } });
        expect(msg).toContain('ERROR: taxonomy_id is required.');
    });
});

describe('cleanStderr', () => {
    test('empty -> null', () => {
        expect(cleanStderr('')).toBeNull();
        expect(cleanStderr(null)).toBeNull();
    });
});
