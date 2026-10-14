// planSteps.js
//
// D4 Phase 3: plan step results stored server-side on the plan message.
//
// Before, a plan's step results lived only in the browser (PlanCard built
// completed_step_results and sent them on every Continue); a reload sent {}
// and the next step lost the ids, group paths and job folders it needed.
// Now every plan_step_* event of a turn becomes an update on
// message.plan.steps[i] ({status, result_summary, step_outputs}), written
// after the stream, and an execute_next request has the stored outputs
// merged into its completed_step_results.

const STATUS_BY_EVENT = {
  plan_step_started: 'running',
  plan_step_completed: 'completed',
  plan_step_failed: 'failed',
  plan_step_needs_input: 'needs_input',
  plan_step_blocked: 'awaiting_approval',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The step update a plan_step_* (or plan_workflow_submitted) event implies,
 * or null.  plan_workflow_submitted adds outputs only (the step's status
 * comes from its plan_step_completed).
 */
function stepUpdateFromEvent(eventType, data) {
  if (!isPlainObject(data) || !data.plan_id) return null;
  const index = Number.isInteger(data.step_index) ? data.step_index : null;
  if (index === null && !data.step_id) return null;
  const update = { plan_id: data.plan_id, step_id: data.step_id || null, step_index: index };
  if (STATUS_BY_EVENT[eventType]) update.status = STATUS_BY_EVENT[eventType];
  else if (eventType !== 'plan_workflow_submitted') return null;
  if (typeof data.result_summary === 'string' && data.result_summary) {
    update.result_summary = data.result_summary.slice(0, 1500);
  }
  if (eventType === 'plan_step_failed' && typeof data.error === 'string') {
    update.error_message = data.error.slice(0, 1500);
  }
  if (isPlainObject(data.step_outputs) && Object.keys(data.step_outputs).length > 0) {
    update.step_outputs = data.step_outputs;
  }
  return update;
}

/** Merge step_outputs objects: lists concatenated without duplicates, maps updated. */
function mergeStepOutputs(...parts) {
  const out = {};
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    for (const [key, val] of Object.entries(part)) {
      if (Array.isArray(val)) {
        const existing = out[key] || (out[key] = []);
        const seen = new Set(existing.map(v => JSON.stringify(v)));
        for (const item of val) {
          const k = JSON.stringify(item);
          if (!seen.has(k)) { existing.push(item); seen.add(k); }
        }
      } else if (isPlainObject(val)) {
        out[key] = Object.assign(out[key] || {}, val);
      }
    }
  }
  return out;
}

function findStepIndex(steps, update) {
  if (update.step_id) {
    const byId = steps.findIndex(s => s && s.step_id === update.step_id);
    if (byId !== -1) return byId;
  }
  return update.step_index !== null && update.step_index < steps.length ? update.step_index : -1;
}

/**
 * A copy of *plan* with *updates* applied (those for other plans ignored).
 * A completed step is never set back to running or awaiting_approval by a
 * late event.
 */
function applyStepUpdates(plan, updates) {
  if (!isPlainObject(plan) || !Array.isArray(plan.steps)) return plan;
  const next = { ...plan, steps: plan.steps.map(s => (isPlainObject(s) ? { ...s } : s)) };
  for (const u of updates || []) {
    if (!u || u.plan_id !== plan.plan_id) continue;
    const i = findStepIndex(next.steps, u);
    if (i === -1 || !isPlainObject(next.steps[i])) continue;
    const step = next.steps[i];
    if (u.status && !(step.status === 'completed' && ['running', 'awaiting_approval'].includes(u.status))) {
      step.status = u.status;
    }
    if (u.result_summary) step.result_summary = u.result_summary;
    if (u.error_message) step.error_message = u.error_message;
    if (u.step_outputs) step.step_outputs = mergeStepOutputs(step.step_outputs, u.step_outputs);
  }
  return next;
}

/**
 * The browser's edited plan with the server-stored step_outputs kept.  The
 * PlanCard saves the whole plan on every change and does not hold the
 * outputs, so a plain replace would erase them.
 */
function keepStoredOutputs(incomingPlan, storedPlan) {
  if (!isPlainObject(incomingPlan) || !Array.isArray(incomingPlan.steps)) return incomingPlan;
  const stored = isPlainObject(storedPlan) && Array.isArray(storedPlan.steps) ? storedPlan.steps : [];
  const byId = new Map(stored.filter(isPlainObject).map(s => [s.step_id, s]));
  return {
    ...incomingPlan,
    steps: incomingPlan.steps.map(s => {
      if (!isPlainObject(s)) return s;
      const old = byId.get(s.step_id);
      if (!old || !isPlainObject(old.step_outputs)) return s;
      return { ...s, step_outputs: mergeStepOutputs(old.step_outputs, s.step_outputs) };
    }),
  };
}

/** The newest message in *messages* holding the plan with *planId*, or null. */
function findPlanMessage(messages, planId) {
  if (!Array.isArray(messages) || !planId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && isPlainObject(m.plan) && m.plan.plan_id === planId) return m;
  }
  return null;
}

/**
 * completed_step_results for an execute_next request, with the stored
 * step results merged in.  Stored step_outputs always win (the browser does
 * not hold them); the browser's answer text is kept, and a stored
 * result_summary fills in when the browser sent nothing for a step (reload).
 */
function mergeCompletedResults(browserResults, storedPlan) {
  const merged = isPlainObject(browserResults) ? { ...browserResults } : {};
  const steps = isPlainObject(storedPlan) && Array.isArray(storedPlan.steps) ? storedPlan.steps : [];
  for (const step of steps) {
    if (!isPlainObject(step) || !step.step_id) continue;
    const hasOutputs = isPlainObject(step.step_outputs) && Object.keys(step.step_outputs).length > 0;
    const done = step.status === 'completed';
    if (!hasOutputs && !(done && step.result_summary)) continue;
    const entry = isPlainObject(merged[step.step_id]) ? { ...merged[step.step_id] } : {};
    if (hasOutputs) entry.step_outputs = step.step_outputs;
    if (!entry.answer && !entry.result_summary && step.result_summary) {
      entry.result_summary = step.result_summary;
    }
    merged[step.step_id] = entry;
  }
  return merged;
}

module.exports = {
  STATUS_BY_EVENT,
  stepUpdateFromEvent,
  mergeStepOutputs,
  applyStepUpdates,
  keepStoredOutputs,
  findPlanMessage,
  mergeCompletedResults,
};
