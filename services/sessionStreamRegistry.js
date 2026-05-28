// services/sessionStreamRegistry.js
//
// Lightweight in-memory registry that maps session_id → active SSE
// response streams.  This allows out-of-band events (e.g. workflow
// completion webhooks) to push real-time SSE events to any frontend
// client that currently has an open connection for that session.
//
// Streams are registered when a /copilot-agent SSE request starts and
// unregistered when the connection closes.  A session may have multiple
// concurrent streams (e.g. two browser tabs), so we store a Set per
// session_id.

const { emitSSE } = require('./sseUtils');

/** @type {Map<string, Set<object>>} */
const registry = new Map();

/**
 * Register an active SSE response stream for a session.
 * @param {string} sessionId
 * @param {object} res - Express response object (SSE stream)
 */
function register(sessionId, res) {
  if (!sessionId || !res) return;
  if (!registry.has(sessionId)) {
    registry.set(sessionId, new Set());
  }
  registry.get(sessionId).add(res);
}

/**
 * Unregister an SSE response stream for a session.
 * @param {string} sessionId
 * @param {object} res - Express response object
 */
function unregister(sessionId, res) {
  if (!sessionId || !res) return;
  const streams = registry.get(sessionId);
  if (streams) {
    streams.delete(res);
    if (streams.size === 0) {
      registry.delete(sessionId);
    }
  }
}

/**
 * Push an SSE event to all active streams for a session.
 * Returns the number of streams the event was pushed to.
 *
 * @param {string} sessionId
 * @param {string} eventType - SSE event name
 * @param {object} data - Event payload (will be JSON-serialised)
 * @returns {number} Number of streams notified
 */
function pushToSession(sessionId, eventType, data) {
  if (!sessionId) return 0;
  const streams = registry.get(sessionId);
  if (!streams || streams.size === 0) return 0;

  let count = 0;
  for (const res of streams) {
    try {
      if (res.writableEnded || res.destroyed) {
        streams.delete(res);
        continue;
      }
      emitSSE(res, eventType, data);
      count++;
    } catch (_) {
      // Connection dead — remove it
      streams.delete(res);
    }
  }
  if (streams.size === 0) {
    registry.delete(sessionId);
  }
  return count;
}

/**
 * Check whether a session has any active SSE streams.
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasActiveStreams(sessionId) {
  const streams = registry.get(sessionId);
  return !!(streams && streams.size > 0);
}

module.exports = {
  register,
  unregister,
  pushToSession,
  hasActiveStreams
};
