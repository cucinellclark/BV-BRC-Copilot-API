// sessionTurnLock.js
//
// One chat turn at a time per session.  On 2026-10-09 users re-sent messages
// while a slow turn ran (nbowers 9 times), and one "Submit this job" click
// became five concurrent turns (parrello, five identical jobs in 5 s).  Each
// extra turn competed for the same LLM and could submit the same job again.
//
// A Redis key per session, claimed with SET NX: atomic across gateway
// processes, and the TTL frees it if the gateway dies mid-turn (a stale Mongo
// active_job_id has no such expiry).  Release is compare-and-delete so a late
// finishing turn never frees a newer turn's lock.

const LOCK_KEY_PREFIX = 'copilot:session_turn:';

// Compare-and-delete: only the holder may release.
const RELEASE_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

function lockKey(sessionId) {
  return `${LOCK_KEY_PREFIX}${sessionId}`;
}

/**
 * Claim the session for jobId.  Returns true if claimed (or if there is no
 * session id / Redis fails -- fail open, like the chat-slot gate), false if
 * another turn holds it.
 */
async function acquireSessionTurn(redis, sessionId, jobId, ttlMs, logger) {
  if (!sessionId) return true;
  try {
    const ok = await redis.set(lockKey(sessionId), jobId, 'PX', ttlMs, 'NX');
    return ok === 'OK';
  } catch (err) {
    if (logger) logger.warn('Session turn lock unavailable, allowing turn', { sessionId, error: err.message });
    return true;
  }
}

/** Release the session if jobId still holds it.  Best-effort. */
async function releaseSessionTurn(redis, sessionId, jobId) {
  if (!sessionId || !jobId) return;
  try {
    await redis.eval(RELEASE_LUA, 1, lockKey(sessionId), jobId);
  } catch (_) {
    // The TTL frees it.
  }
}

module.exports = {
  LOCK_KEY_PREFIX,
  acquireSessionTurn,
  releaseSessionTurn,
};
