// services/chatRunner.js
//
// Shared in-request runner for all chat SSE routes.  Replaces Bull queue
// for live chat — the process that accepted the POST talks to the
// orchestrator directly and writes SSE tokens on the same response.
//
// Redis is used for:
//   - copilot:cancel:{jobId}  — Stop flag; any gateway instance can set it
//   - copilot:chat_slots      — sorted-set admission gate (max_chats seats)
//   - copilot:session:{sessionId} — pub/sub for workflow_complete (Phase 4)
//
// Bull is KEPT for the workflow monitor queue.

const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const { createLogger } = require('./logger');
const { executeOrchestratorLoop } = require('./orchestratorClient');
const { writeSseEvent } = require('./sseUtils');
const { getQueueRedisConfig } = require('./queueRedisConfig');
const {
  register: registerSessionStream,
  unregister: unregisterSessionStream,
} = require('./sessionStreamRegistry');
const {
  setSessionActiveJob,
  clearSessionActiveJob,
} = require('./dbUtils');

const logger = createLogger('ChatRunner');

// ---------------------------------------------------------------------------
// Redis client for cancel flags (reuses the same Redis instance as Bull)
// ---------------------------------------------------------------------------

const redisConfig = getQueueRedisConfig();
const redis = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  db: redisConfig.db,
  password: redisConfig.password || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.connect().catch(err => {
  logger.error('Failed to connect to Redis for cancel flags', { error: err.message });
});

const CANCEL_KEY_PREFIX = 'copilot:cancel:';
const CANCEL_TTL_SECONDS = 600; // 10 minutes — long enough for any turn

// ---------------------------------------------------------------------------
// Chat-slot admission (Redis sorted set with TTL safety)
// ---------------------------------------------------------------------------
// Limits concurrent chat turns to avoid stampeding the orchestrator / LLM.
// Uses a sorted set where score = expiry timestamp (unix seconds) and
// member = jobId.  Entries self-heal after slot_ttl_seconds if the
// gateway crashes without releasing.

const config = require('../config.json');
const ADMISSION_CONFIG = config.admission || {};
const MAX_CHATS = ADMISSION_CONFIG.max_chats || 8;
const ADMISSION_WAIT_MS = ADMISSION_CONFIG.wait_ms || 300000; // 5 min default
const SLOT_TTL_SECONDS = ADMISSION_CONFIG.slot_ttl_seconds || 600;
const MAX_WAITING_CHATS = ADMISSION_CONFIG.max_waiting_chats || 32;
const CHAT_SLOTS_KEY = 'copilot:chat_slots';
const SLOT_POLL_INTERVAL_MS = 1000;

// Lua script: atomically prune expired entries, check capacity, and claim
// a slot if room is available.
//   KEYS[1] = sorted set key
//   ARGV[1] = now (unix seconds)
//   ARGV[2] = max_chats
//   ARGV[3] = expiry score (now + ttl)
//   ARGV[4] = jobId (member)
// Returns 1 if slot acquired, 0 if full.
const ACQUIRE_SLOT_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
    return 1
  end
  return 0
`;

/**
 * Count the number of currently held chat slots (after pruning expired).
 * Used to check whether the waiter cap has been reached BEFORE opening SSE.
 * @returns {Promise<number>}
 */
async function countChatSlots() {
  try {
    const now = Math.floor(Date.now() / 1000);
    await redis.zremrangebyscore(CHAT_SLOTS_KEY, '-inf', now);
    return await redis.zcard(CHAT_SLOTS_KEY);
  } catch (err) {
    // Redis down — fail open (report 0 so we don't 429)
    logger.warn('Redis ZCARD failed, reporting 0 slots', { error: err.message });
    return 0;
  }
}

/**
 * Try to acquire a chat slot.  Polls up to wait_ms, then rejects.
 * Supports an AbortController signal for early exit (Stop or disconnect).
 * @param {string} jobId
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] — abort to exit without acquiring
 * @returns {Promise<'acquired'|'timeout'|'aborted'>}
 */
async function acquireChatSlot(jobId, { signal } = {}) {
  const deadline = Date.now() + ADMISSION_WAIT_MS;

  while (true) {
    // Check abort before each attempt
    if (signal && signal.aborted) return 'aborted';

    const now = Math.floor(Date.now() / 1000);
    const expiry = now + SLOT_TTL_SECONDS;
    try {
      const result = await redis.eval(
        ACQUIRE_SLOT_LUA,
        1,               // number of keys
        CHAT_SLOTS_KEY,  // KEYS[1]
        now,             // ARGV[1]
        MAX_CHATS,       // ARGV[2]
        expiry,          // ARGV[3]
        jobId,           // ARGV[4]
      );
      if (result === 1) return 'acquired';
    } catch (err) {
      // Redis down — fail open (allow the turn) rather than blocking everyone
      logger.warn('Redis chat-slot check failed, allowing turn', { jobId, error: err.message });
      return 'acquired';
    }

    if (Date.now() >= deadline) {
      return 'timeout';
    }

    // Sleep, but wake early on abort
    await new Promise(resolve => {
      const timer = setTimeout(resolve, SLOT_POLL_INTERVAL_MS);
      if (signal) {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

/**
 * Release a chat slot.
 * @param {string} jobId
 */
async function releaseChatSlot(jobId) {
  try {
    await redis.zrem(CHAT_SLOTS_KEY, jobId);
  } catch (_) {
    // best-effort — entry will expire via TTL if Redis fails
  }
}

/**
 * Set the cancel flag for a job.
 * @param {string} jobId
 */
async function setCancelFlag(jobId) {
  try {
    await redis.set(`${CANCEL_KEY_PREFIX}${jobId}`, '1', 'EX', CANCEL_TTL_SECONDS);
  } catch (err) {
    logger.warn('Failed to set cancel flag in Redis', { jobId, error: err.message });
  }
}

/**
 * Check whether the cancel flag is set for a job.
 * @param {string} jobId
 * @returns {boolean}
 */
async function isCancelled(jobId) {
  try {
    const val = await redis.exists(`${CANCEL_KEY_PREFIX}${jobId}`);
    return val === 1;
  } catch (err) {
    // Redis down — don't block the turn
    return false;
  }
}

/**
 * Clear the cancel flag for a job (cleanup after completion).
 * @param {string} jobId
 */
async function clearCancelFlag(jobId) {
  try {
    await redis.del(`${CANCEL_KEY_PREFIX}${jobId}`);
  } catch (_) {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// In-flight turn tracking (process-local)
// ---------------------------------------------------------------------------

/** @type {Map<string, { promise: Promise, abortOrchestrator: Function|null }>} */
const inFlightTurns = new Map();

/**
 * Get info about an in-flight turn.
 * @param {string} jobId
 * @returns {object|null}
 */
function getInFlightTurn(jobId) {
  return inFlightTurns.get(jobId) || null;
}

// ---------------------------------------------------------------------------
// Shared SSE runner
// ---------------------------------------------------------------------------

/**
 * Run a chat turn in-request (no Bull).
 *
 * Sets up the SSE response, calls executeOrchestratorLoop directly,
 * and manages the lifecycle (heartbeat, cancel, persist, cleanup).
 *
 * The `res` SSE stream may close (session switch) without cancelling
 * the turn — the orchestrator call continues and persists to Mongo.
 * Only an explicit `POST /job/:id/abort` sets the Redis cancel flag.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response (SSE stream)
 * @param {object} jobData - Data for executeOrchestratorLoop (query, model, session_id, etc.)
 * @returns {Promise<void>}
 */
async function runChatTurn(req, res, jobData) {
  const jobId = uuidv4();
  const sessionId = jobData.session_id;
  const turnLogger = createLogger('ChatTurn', sessionId);

  // --- Waiter-cap check (BEFORE opening SSE) ---
  // If too many connections are already waiting, reject immediately with
  // a plain 429 JSON response.  This is the last-resort path; under
  // normal load, callers wait on SSE and complete when a seat frees.
  const currentSlots = await countChatSlots();
  if (currentSlots >= MAX_CHATS) {
    // All seats are taken — check how many extra waiters are acceptable
    // This is a rough count: slots held + in-flight waiters on this
    // process.  Since we cannot count waiters across gateway instances
    // we use the local in-flight map size as a proxy.
    const waiters = inFlightTurns.size - currentSlots; // waiters ≈ turns without a slot
    if (waiters >= MAX_WAITING_CHATS) {
      turnLogger.warn('Waiter cap exceeded, returning 429', {
        jobId, currentSlots, waiters, MAX_WAITING_CHATS,
      });
      res.status(429).json({
        error: 'The system is busy. Please try again in a moment.',
      });
      return;
    }
  }

  // --- Open SSE immediately (before waiting for a slot) ---
  // This keeps the browser connection alive so we can send `queued`
  // status, heartbeats, and eventually stream the agent response.
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  // Padding comment + flush to coax nginx into sending the first frame
  res.write(': connected\n\n');
  if (typeof res.flush === 'function') {
    res.flush();
  }

  // Track whether the SSE writer is still open (session switch closes it)
  let sseOpen = true;

  // --- SSE writer (safe for dead connections) ---
  const sseWriter = (eventType, data) => {
    if (!sseOpen || res.writableEnded || res.destroyed) return;
    try {
      writeSseEvent(res, eventType, data);
    } catch (_) {
      sseOpen = false;
    }
  };

  // --- Heartbeat (starts NOW, before slot wait) ---
  const heartbeatInterval = setInterval(() => {
    if (!sseOpen || res.writableEnded || res.destroyed) {
      clearInterval(heartbeatInterval);
      return;
    }
    try {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  // --- AbortController: unifies Stop + disconnect during wait ---
  const waitAbort = new AbortController();

  // Client disconnect: abort the wait (do NOT take a seat), close writer.
  // Use res.on('close') — fires on real socket close.
  res.on('close', () => {
    turnLogger.info('Client disconnected (SSE closed)', { jobId });
    sseOpen = false;
    waitAbort.abort();
    unregisterSessionStream(sessionId, res);
    clearInterval(heartbeatInterval);
    // NOTE: if the turn already started (slot acquired), the
    // orchestrator call continues and persists to Mongo.  If still
    // waiting for a slot, the abort signal causes acquireChatSlot to
    // return 'aborted' — the slot is never taken.
  });

  // --- Register in-flight turn (counts toward local waiter estimate) ---
  let turnResolve;
  const turnPromise = new Promise(resolve => { turnResolve = resolve; });
  inFlightTurns.set(jobId, { promise: turnPromise });

  // --- Chat-slot admission gate (wait in SSE) ---
  // Try a fast first attempt.  If the system is at capacity, emit
  // `queued` and wait with heartbeats + abort support.
  let slotOutcome;
  {
    // Fast path: try once without waiting
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + SLOT_TTL_SECONDS;
    let fastResult = 0;
    try {
      fastResult = await redis.eval(
        ACQUIRE_SLOT_LUA, 1, CHAT_SLOTS_KEY, now, MAX_CHATS, expiry, jobId,
      );
    } catch (err) {
      logger.warn('Redis chat-slot fast check failed, allowing turn', { jobId, error: err.message });
      fastResult = 1; // fail-open
    }

    if (fastResult === 1) {
      slotOutcome = 'acquired';
    } else {
      // System is busy — tell the user and wait
      turnLogger.info('All chat slots busy, entering wait queue', {
        jobId, currentSlots: MAX_CHATS,
      });
      sseWriter('queued', {
        job_id: jobId,
        session_id: sessionId,
        message: 'High usage \u2014 responses will be slower.',
        timestamp: new Date().toISOString(),
      });

      // Wire Redis cancel flag into the abort controller so Stop
      // during wait also aborts without taking a seat.
      const cancelCheckDuringWait = setInterval(async () => {
        if (await isCancelled(jobId)) {
          waitAbort.abort();
          clearInterval(cancelCheckDuringWait);
        }
      }, 1000);

      slotOutcome = await acquireChatSlot(jobId, { signal: waitAbort.signal });

      clearInterval(cancelCheckDuringWait);
    }
  }

  // Handle non-acquired outcomes
  if (slotOutcome === 'aborted') {
    turnLogger.info('Wait aborted (Stop or disconnect) — slot NOT taken', { jobId });
    sseWriter('cancelled', {
      job_id: jobId,
      message: 'Stopped by user',
      timestamp: new Date().toISOString(),
    });
    sseWriter('done', {
      job_id: jobId,
      session_id: sessionId,
      cancelled: true,
      message: 'Stopped by user',
      timestamp: new Date().toISOString(),
    });
    // Cleanup — no slot to release
    clearInterval(heartbeatInterval);
    inFlightTurns.delete(jobId);
    unregisterSessionStream(sessionId, res);
    await clearCancelFlag(jobId);
    turnResolve();
    if (sseOpen && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch (_) {}
    }
    return;
  }

  if (slotOutcome === 'timeout') {
    // After 5 minutes waiting — very rare.  Return an error on the
    // already-open SSE so the frontend can show it gracefully.
    turnLogger.warn('Chat-slot wait timed out after wait_ms', { jobId, ADMISSION_WAIT_MS });
    sseWriter('error', {
      job_id: jobId,
      error: 'The system is busy. Please try again in a moment.',
      timestamp: new Date().toISOString(),
    });
    sseWriter('done', {
      job_id: jobId,
      session_id: sessionId,
      cancelled: false,
      message: 'Timed out waiting for a chat slot',
      timestamp: new Date().toISOString(),
    });
    clearInterval(heartbeatInterval);
    inFlightTurns.delete(jobId);
    unregisterSessionStream(sessionId, res);
    turnResolve();
    if (sseOpen && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch (_) {}
    }
    return;
  }

  // --- Slot acquired — proceed with the chat turn ---
  turnLogger.info('Chat slot acquired', { jobId });

  // Register session stream for out-of-band events (workflow completion)
  registerSessionStream(sessionId, res);

  // Persist active_job_id to Mongo so other tabs / sidebar know
  await setSessionActiveJob(sessionId, jobId).catch((err) => {
    turnLogger.warn('Failed to set active_job_id', { sessionId, jobId, error: err.message });
  });

  // Emit started event with the job_id
  sseWriter('started', {
    job_id: jobId,
    session_id: sessionId,
    message: 'Processing started',
    timestamp: new Date().toISOString(),
  });

  // --- shouldCancel polls Redis ---
  let cancelledFlag = false;
  const cancelPollInterval = setInterval(async () => {
    if (await isCancelled(jobId)) {
      cancelledFlag = true;
      clearInterval(cancelPollInterval);
    }
  }, 200);
  const shouldCancelSync = () => cancelledFlag;

  // Build a responseStream wrapper that writes to the SSE response.
  // executeOrchestratorLoop calls emitSSE(responseStream, ...) which
  // writes to this object.
  const responseStream = {
    write: (data) => {
      if (!sseOpen || res.writableEnded || res.destroyed) return;
      try {
        res.write(data);
        if (typeof res.flush === 'function') res.flush();
      } catch (_) {
        sseOpen = false;
      }
    },
    end: () => { /* no-op: we control res.end() */ },
    writableEnded: false,
    get destroyed() { return res.destroyed; },
    flushHeaders: () => {},
    flush: () => {
      if (typeof res.flush === 'function') {
        try { res.flush(); } catch (_) {}
      }
    },
  };

  // --- Run the orchestrator loop ---
  try {
    const agentOpts = {
      ...jobData,
      job_id: jobId,
      stream: true,
      responseStream,
      shouldCancel: shouldCancelSync,
      progressCallback: (iteration, tool, status) => {
        // Check cancel at each progress callback
        if (cancelledFlag) {
          const cancelError = new Error('Job cancelled by user');
          cancelError.name = 'JobCancelledError';
          cancelError.isCancelled = true;
          throw cancelError;
        }

        sseWriter('progress', {
          iteration,
          tool,
          status,
          timestamp: new Date().toISOString(),
        });
      },
    };

    const result = await executeOrchestratorLoop(agentOpts);

    if (result.cancelled) {
      // Cancelled — partial text was persisted to Mongo in
      // executeOrchestratorLoop before returning.
      turnLogger.info('Chat turn cancelled (Stop), partial text persisted', { jobId });
      sseWriter('cancelled', {
        job_id: jobId,
        message: 'Stopped by user',
        timestamp: new Date().toISOString(),
      });
      sseWriter('done', {
        job_id: jobId,
        session_id: sessionId,
        cancelled: true,
        message: 'Stopped by user',
        timestamp: new Date().toISOString(),
      });
    } else {
      // Success — emit done
      sseWriter('done', {
        job_id: jobId,
        session_id: sessionId,
        iterations: result.iterations || 0,
        tools_used: result.toolsUsed || [],
        timestamp: new Date().toISOString(),
      });
    }

    turnLogger.info('Chat turn completed', {
      jobId,
      iterations: result.iterations || 0,
      cancelled: !!result.cancelled,
    });

  } catch (err) {
    if (err && err.isCancelled) {
      // Fallback: cancel error escaped without persisting (should not
      // happen after the fix above, but kept as a safety net).
      turnLogger.warn('Chat turn cancelled (Stop) without persist', { jobId });
      sseWriter('cancelled', {
        job_id: jobId,
        message: 'Stopped by user',
        timestamp: new Date().toISOString(),
      });
      sseWriter('done', {
        job_id: jobId,
        session_id: sessionId,
        cancelled: true,
        message: 'Stopped by user',
        timestamp: new Date().toISOString(),
      });
    } else {
      turnLogger.error('Chat turn failed', { jobId, error: err.message });
      sseWriter('error', {
        job_id: jobId,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    // Cleanup
    clearInterval(cancelPollInterval);
    clearInterval(heartbeatInterval);
    await clearCancelFlag(jobId);
    // Release chat-slot (entry expires via TTL if this fails)
    await releaseChatSlot(jobId);
    // Clear active_job_id (only if it still matches this turn)
    await clearSessionActiveJob(sessionId, jobId).catch(() => {});
    inFlightTurns.delete(jobId);
    unregisterSessionStream(sessionId, res);
    turnResolve();

    // Close SSE stream if still open
    if (sseOpen && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch (_) {}
    }
  }
}

module.exports = {
  runChatTurn,
  setCancelFlag,
  isCancelled,
  clearCancelFlag,
  getInFlightTurn,
};
