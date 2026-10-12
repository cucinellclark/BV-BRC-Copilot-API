// replayActions.js
//
// "Submit this job" on an execution_blocked card sends back the exact calls
// that plan mode refused (blocked_actions).  The service agent runs them
// verbatim instead of asking the LLM to rebuild the job, which on 2026-10-09
// submitted different parameters than the card showed.
//
// The actions come from the browser, so the gateway only forwards them when
// they match a card already stored in the session -- the user can replay what
// the assistant prepared, not arbitrary tool calls.

const REPLAYABLE_TOOLS = new Set(['submit_gowe_job', 'create_group']);
const MAX_REPLAY_ACTIONS = 10;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check the request shape.  Returns { actions } with only the fields the
 * orchestrator needs, or { error } with a message for a 400.
 */
function validateReplayActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { error: 'replay_actions must be a non-empty array' };
  }
  if (actions.length > MAX_REPLAY_ACTIONS) {
    return { error: `replay_actions may hold at most ${MAX_REPLAY_ACTIONS} actions` };
  }
  const cleaned = [];
  for (const action of actions) {
    if (!isPlainObject(action) || !REPLAYABLE_TOOLS.has(action.tool) || !isPlainObject(action.arguments)) {
      return { error: 'each replay action needs a tool (submit_gowe_job or create_group) and an arguments object' };
    }
    cleaned.push({
      tool: action.tool,
      arguments: action.arguments,
      summary: typeof action.summary === 'string' ? action.summary : action.tool,
    });
  }
  return { actions: cleaned };
}

// JSON with object keys sorted at every level, so two copies of the same
// action compare equal however their keys were ordered on the way through.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function actionKey(action) {
  return canonicalJson({ tool: action.tool, arguments: action.arguments });
}

/**
 * True when every action appears in the blocked_actions of one stored
 * execution_blocked card in the session's messages.
 */
function matchesStoredCard(actions, messages) {
  if (!Array.isArray(messages)) return false;
  const wanted = actions.map(actionKey);
  return messages.some(m => {
    const card = m && m.card;
    if (!card || card.card_type !== 'execution_blocked') return false;
    const stored = new Set(((card.card_payload && card.card_payload.blocked_actions) || []).map(actionKey));
    return wanted.every(k => stored.has(k));
  });
}

module.exports = {
  REPLAYABLE_TOOLS,
  MAX_REPLAY_ACTIONS,
  validateReplayActions,
  matchesStoredCard,
  canonicalJson,
};
