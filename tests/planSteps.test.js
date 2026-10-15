/**
 * D4 Phase 3: plan step results stored server-side, and the plan-step
 * events the gateway maps.
 *
 *  - services/planSteps.js: event -> step update, merge rules, edit keeps
 *    stored outputs, execute_next gets the stored outputs
 *  - mapOrchestratorEvent: plan_step_blocked SSE, step updates collected on
 *    state, plan ids kept for the workflow watch, step_outputs forwarded
 */

const mockEmitSSE = jest.fn();
jest.mock('../services/sseUtils', () => ({ emitSSE: mockEmitSSE, writeSseEvent: jest.fn() }));
jest.mock('../config.json', () => ({}), { virtual: true });
jest.mock('../services/logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../services/dbUtils', () => ({}));
jest.mock('../services/workflowMonitorService', () => ({ registerWorkflowWatch: jest.fn() }));
jest.mock('../services/memory/conversationContextService', () => ({
    buildConversationContext: jest.fn(), buildWorkflowAwareHistory: jest.fn(),
}));
jest.mock('../services/internalKey', () => ({ internalKeyHeaders: () => ({}) }), { virtual: false });

const {
    stepUpdateFromEvent, mergeStepOutputs, applyStepUpdates,
    keepStoredOutputs, findPlanMessage, mergeCompletedResults,
} = require('../services/planSteps');
const { mapOrchestratorEvent } = require('../services/orchestratorClient');

const GROUP = { name: 'g', path: '/u/home/Feature Groups/g', type: 'feature_group', count: 100 };
const plan = () => ({
    plan_id: 'p1',
    steps: [
        { step_id: 'find_plfam', status: 'completed', result_summary: 'PLF_1' },
        { step_id: 'make_group', status: 'pending' },
        { step_id: 'run_msa', status: 'pending' },
    ],
});

beforeEach(() => mockEmitSSE.mockReset());

describe('stepUpdateFromEvent', () => {
    test('maps each plan step event to a status', () => {
        const base = { plan_id: 'p1', step_id: 'make_group', step_index: 1 };
        expect(stepUpdateFromEvent('plan_step_blocked', base).status).toBe('awaiting_approval');
        expect(stepUpdateFromEvent('plan_step_completed', { ...base, step_outputs: { groups: [GROUP] } }))
            .toEqual({ ...base, status: 'completed', step_outputs: { groups: [GROUP] } });
        expect(stepUpdateFromEvent('plan_step_failed', { ...base, error: 'boom' }).error_message).toBe('boom');
        // workflow_submitted adds outputs only; the status comes from completed.
        const sub = stepUpdateFromEvent('plan_workflow_submitted', { ...base, step_outputs: { submission_ids: ['s'] } });
        expect(sub.status).toBeUndefined();
        expect(sub.step_outputs).toEqual({ submission_ids: ['s'] });
        expect(stepUpdateFromEvent('execution_blocked', base)).toBeNull();
        expect(stepUpdateFromEvent('plan_step_completed', { step_index: 1 })).toBeNull();
    });
});

describe('applyStepUpdates', () => {
    test('writes status and merges outputs on the right step', () => {
        const next = applyStepUpdates(plan(), [
            { plan_id: 'p1', step_id: 'make_group', step_index: 1, status: 'awaiting_approval',
              step_outputs: { values: { plfam_id: 'PLF_1' } } },
            { plan_id: 'p1', step_id: 'make_group', step_index: 1, status: 'completed',
              step_outputs: { groups: [GROUP] } },
            { plan_id: 'other', step_index: 2, status: 'failed' },
        ]);
        expect(next.steps[1]).toEqual({ step_id: 'make_group', status: 'completed',
            step_outputs: { values: { plfam_id: 'PLF_1' }, groups: [GROUP] } });
        expect(next.steps[2].status).toBe('pending');
    });

    test('a late running or awaiting event does not reopen a completed step', () => {
        const next = applyStepUpdates(plan(), [{ plan_id: 'p1', step_id: 'find_plfam', step_index: 0, status: 'running' }]);
        expect(next.steps[0].status).toBe('completed');
    });

    test('mergeStepOutputs drops duplicates', () => {
        expect(mergeStepOutputs({ submission_ids: ['a'] }, { submission_ids: ['a', 'b'] }))
            .toEqual({ submission_ids: ['a', 'b'] });
    });
});

describe('stored outputs survive the browser', () => {
    test('/plan/:id/edit keeps stored step_outputs the PlanCard does not hold', () => {
        const stored = applyStepUpdates(plan(), [{ plan_id: 'p1', step_id: 'make_group', step_index: 1,
            step_outputs: { groups: [GROUP] } }]);
        const fromBrowser = { ...plan(), steps: plan().steps.map(s => ({ ...s, status: 'completed' })) };
        const saved = keepStoredOutputs(fromBrowser, stored);
        expect(saved.steps[1].step_outputs).toEqual({ groups: [GROUP] });
        expect(saved.steps[1].status).toBe('completed');
    });

    test('execute_next gets the stored outputs, even after a reload sent {}', () => {
        const stored = applyStepUpdates(plan(), [
            { plan_id: 'p1', step_id: 'find_plfam', step_index: 0, step_outputs: { values: { plfam_id: 'PLF_1' } } },
            { plan_id: 'p1', step_id: 'make_group', step_index: 1, status: 'completed',
              result_summary: 'made', step_outputs: { groups: [GROUP] } },
        ]);
        expect(mergeCompletedResults({}, stored)).toEqual({
            find_plfam: { step_outputs: { values: { plfam_id: 'PLF_1' } }, result_summary: 'PLF_1' },
            make_group: { step_outputs: { groups: [GROUP] }, result_summary: 'made' },
        });
        // The browser's answer text is kept; the stored outputs win.
        const merged = mergeCompletedResults({ make_group: { answer: 'from browser', step_outputs: {} } }, stored);
        expect(merged.make_group).toEqual({ answer: 'from browser', step_outputs: { groups: [GROUP] } });
    });

    test('findPlanMessage picks the newest message with that plan', () => {
        const msgs = [{ plan: { plan_id: 'p1', v: 1 } }, { role: 'user' }, { plan: { plan_id: 'p1', v: 2 } }];
        expect(findPlanMessage(msgs, 'p1').plan.v).toBe(2);
        expect(findPlanMessage(msgs, 'nope')).toBeNull();
    });
});

describe('mapOrchestratorEvent plan steps', () => {
    const CTX = { plan_id: 'p1', step_id: 'make_group', step_index: 1 };

    test('plan_step_blocked is forwarded and recorded', () => {
        const state = {};
        mapOrchestratorEvent('plan_step_blocked', { ...CTX, agent: 'data', summaries: ['feature_group g'],
            step_outputs: { values: { plfam_id: 'PLF_1' } } }, {}, state);
        const [, type, payload] = mockEmitSSE.mock.calls[0];
        expect(type).toBe('plan_step_blocked');
        expect(payload).toMatchObject({ ...CTX, summaries: ['feature_group g'],
            step_outputs: { values: { plfam_id: 'PLF_1' } } });
        expect(state.planStepUpdates).toEqual([{ ...CTX, status: 'awaiting_approval',
            step_outputs: { values: { plfam_id: 'PLF_1' } } }]);
    });

    test('a submitted plan step keeps its ids for the workflow watch', () => {
        const state = {};
        mapOrchestratorEvent('plan_workflow_submitted', { ...CTX, submission_ids: ['sub_1', 'sub_2'],
            step_outputs: { submission_ids: ['sub_1', 'sub_2'] } }, {}, state);
        expect(state.planWorkflowSubmissions).toEqual([
            { submission_id: 'sub_1', workflow_id: '', ...CTX },
            { submission_id: 'sub_2', workflow_id: '', ...CTX },
        ]);
        expect(mockEmitSSE.mock.calls[0][2].step_outputs).toEqual({ submission_ids: ['sub_1', 'sub_2'] });
    });

    test('plan_step_completed forwards step_outputs', () => {
        mapOrchestratorEvent('plan_step_completed', { ...CTX, step_outputs: { groups: [GROUP] } }, {}, {});
        expect(mockEmitSSE.mock.calls[0][2].step_outputs).toEqual({ groups: [GROUP] });
    });
});

describe('LLM usage on orchestrator_done', () => {
    test('the turn usage is kept on state for the assistant message', () => {
        const state = {};
        const usage = { llm_calls: 3, prompt_tokens: 1200, completion_tokens: 90, by_site: { router: { calls: 1 } } };
        mapOrchestratorEvent('orchestrator_done', { response_text: 'x', usage }, {}, state);
        expect(state.usage).toEqual(usage);
        mapOrchestratorEvent('orchestrator_done', { response_text: 'x' }, {}, state);
        expect(state.usage).toBeNull();
    });
});
