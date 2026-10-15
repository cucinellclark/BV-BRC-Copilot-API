// services/startupMaintenance.js
//
// Housekeeping run when the gateway starts and every few minutes after:
//
//   1. Indexes on chat_sessions and workflow_watches (idempotent).  Both
//      collections had only _id, so every sidebar load and every session or
//      watch lookup scanned the collection.
//   2. Stale busy flags.  active_job_id is set when a turn starts and cleared
//      in the turn's finally block; a gateway crash leaves it set, and the
//      sidebar shows the chat as busy forever (one was stuck since Sep 18).
//      Only flags older than the longest possible turn are cleared: the dev
//      and public gateways share this database, so "clear everything at
//      startup" would cancel the other gateway's live turns in the UI.
//   3. User tokens on workflow watches.  The monitor needs the user's token to
//      ask GoWe about a running job, and nothing after that.  Watches that
//      finished keep no token; watches past the monitor's age limit are
//      marked expired and lose theirs.

const config = require('../config.json');
const { connectToDatabase } = require('./database');
const { createLogger } = require('./logger');

const logger = createLogger('StartupMaintenance');

const INTERVAL_MS = 5 * 60 * 1000;

// Longest a turn can legitimately run: the chat-slot wait, the orchestrator
// call, and a minute of slack (the same bound as the session turn lock).
function maxTurnMs(conf = config) {
  const wait = (conf.admission && conf.admission.wait_ms) || 300000;
  const orchestrator = (conf.orchestrator && conf.orchestrator.timeout_ms) || 600000;
  return wait + orchestrator + 60000;
}

function maxWatchAgeMs(conf = config) {
  const hours = (conf.workflow_monitor && conf.workflow_monitor.max_watch_age_hours) || 72;
  return hours * 3600 * 1000;
}

const INDEXES = {
  chat_sessions: [
    { key: { session_id: 1 }, name: 'session_id_1' },
    { key: { user_id: 1, last_modified: -1 }, name: 'user_id_1_last_modified_-1' },
    { key: { active_job_id: 1 }, name: 'active_job_id_1', sparse: true },
  ],
  workflow_watches: [
    { key: { submission_id: 1 }, name: 'submission_id_1' },
    { key: { status: 1, created_at: 1 }, name: 'status_1_created_at_1' },
    { key: { session_id: 1, created_at: -1 }, name: 'session_id_1_created_at_-1' },
  ],
};

async function ensureIndexes(db) {
  for (const [name, specs] of Object.entries(INDEXES)) {
    try {
      await db.collection(name).createIndexes(specs);
    } catch (err) {
      logger.warn('Index creation failed', { collection: name, error: err.message });
    }
  }
}

/** Clear active_job_id flags older than the longest possible turn. */
async function clearStaleActiveJobs(db, now = Date.now(), conf = config) {
  const cutoff = new Date(now - maxTurnMs(conf));
  const result = await db.collection('chat_sessions').updateMany(
    {
      active_job_id: { $exists: true },
      $or: [
        { active_job_started_at: { $lt: cutoff } },
        // Flags set before active_job_started_at existed
        { active_job_started_at: { $exists: false }, last_modified: { $lt: cutoff } },
      ],
    },
    { $unset: { active_job_id: '', active_job_started_at: '' } }
  );
  return result.modifiedCount || 0;
}

/** Drop user tokens from watches that no longer poll GoWe. */
async function purgeWatchTokens(db, now = Date.now(), conf = config) {
  const watches = db.collection('workflow_watches');
  const expired = await watches.updateMany(
    { status: 'active', created_at: { $lt: new Date(now - maxWatchAgeMs(conf)) } },
    { $set: { status: 'expired', expired_at: new Date(now) }, $unset: { auth_token: '' } }
  );
  const finished = await watches.updateMany(
    { status: { $ne: 'active' }, auth_token: { $exists: true } },
    { $unset: { auth_token: '' } }
  );
  return { expired: expired.modifiedCount || 0, tokensRemoved: finished.modifiedCount || 0 };
}

async function runMaintenance({ indexes = false } = {}) {
  const db = await connectToDatabase();
  if (indexes) await ensureIndexes(db);
  const staleJobs = await clearStaleActiveJobs(db);
  const watches = await purgeWatchTokens(db);
  if (staleJobs || watches.expired || watches.tokensRemoved) {
    logger.info('Maintenance', { staleJobsCleared: staleJobs, ...watches });
  }
  return { staleJobs, ...watches };
}

/** Run once now (with indexes), then every five minutes. Never throws. */
function startMaintenance() {
  const run = (opts) => runMaintenance(opts).catch((err) => {
    logger.warn('Maintenance failed', { error: err.message });
  });
  const first = run({ indexes: true });
  const timer = setInterval(() => run({}), INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return first;
}

module.exports = {
  startMaintenance,
  runMaintenance,
  ensureIndexes,
  clearStaleActiveJobs,
  purgeWatchTokens,
  maxTurnMs,
  INDEXES,
};
