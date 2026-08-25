/**
 * Workflow Monitor Service
 *
 * A Bull queue-based poller that monitors GoWe workflow submissions
 * for completion.  When a watched workflow reaches a terminal state
 * (COMPLETED, FAILED, CANCELLED) the service:
 *   1. Writes a completion message to the chat session in MongoDB
 *   2. Pushes a `workflow_complete` SSE event to any active frontend
 *      streams so the PlanCard can resume execution
 *
 * The watch is registered by orchestratorClient.js when a plan step
 * submits a workflow via the service agent.
 */

const Queue = require('bull');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config.json');
const { createLogger } = require('./logger');
const { connectToDatabase } = require('./database');
const { addMessagesToSession, getChatSession } = require('./dbUtils');
const { pushToSession } = require('./sessionStreamRegistry');
const { getQueueRedisConfig } = require('./queueRedisConfig');

const logger = createLogger('WorkflowMonitor');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const monitorConfig = config.workflow_monitor || {};
const ENABLED = monitorConfig.enabled !== false;
const POLL_INTERVAL_MS = monitorConfig.poll_interval_ms || 60000;
const GOWE_URL = (monitorConfig.gowe_url || 'http://140.221.78.67:12009').replace(/\/+$/, '');
const GOWE_TIMEOUT_MS = monitorConfig.gowe_timeout_ms || 30000;
const WORKER_CONCURRENCY = monitorConfig.worker_concurrency || 1;
const MAX_WATCH_AGE_HOURS = monitorConfig.max_watch_age_hours || 72;

// GoWe terminal states
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// ---------------------------------------------------------------------------
// Bull Queue — repeatable poller
// ---------------------------------------------------------------------------
const redisConfig = getQueueRedisConfig();

const workflowMonitorQueue = new Queue('workflow-monitor', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 1,
    timeout: 120000,       // 2 min max per poll cycle
    removeOnComplete: { age: 300, count: 10 },
    removeOnFail: { age: 3600 }
  }
});

// ---------------------------------------------------------------------------
// Register the repeatable poller job on startup
// ---------------------------------------------------------------------------
if (ENABLED) {
  // Remove any stale repeatable jobs from a previous run, then add fresh
  workflowMonitorQueue.getRepeatableJobs().then(jobs => {
    const removes = jobs
      .filter(j => j.name === 'poll-workflows')
      .map(j => workflowMonitorQueue.removeRepeatableByKey(j.key));
    return Promise.all(removes);
  }).then(() => {
    return workflowMonitorQueue.add(
      'poll-workflows',
      {},
      { repeat: { every: POLL_INTERVAL_MS }, jobId: 'workflow-poll' }
    );
  }).then(() => {
    logger.info('Workflow monitor repeatable job registered', {
      pollIntervalMs: POLL_INTERVAL_MS,
      goweUrl: GOWE_URL,
      maxWatchAgeHours: MAX_WATCH_AGE_HOURS
    });
  }).catch(err => {
    logger.error('Failed to register workflow monitor repeatable job', { error: err.message });
  });

  // -----------------------------------------------------------------------
  // Worker — runs on each tick of the repeatable job
  // -----------------------------------------------------------------------
  workflowMonitorQueue.process('poll-workflows', WORKER_CONCURRENCY, async (_job) => {
    return await pollActiveWorkflows();
  });

  logger.info('Workflow monitor service initialized', {
    enabled: true,
    pollIntervalMs: POLL_INTERVAL_MS,
    goweUrl: GOWE_URL
  });
} else {
  logger.info('Workflow monitor service is DISABLED');
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

/**
 * Poll all active workflow watches and handle any that have completed.
 */
async function pollActiveWorkflows() {
  const db = await connectToDatabase();
  const collection = db.collection('workflow_watches');

  // Find all active watches (not yet completed, not too old)
  const cutoff = new Date(Date.now() - MAX_WATCH_AGE_HOURS * 3600 * 1000);
  const watches = await collection.find({
    status: 'active',
    created_at: { $gte: cutoff }
  }).toArray();

  if (watches.length === 0) {
    return { checked: 0, completed: 0 };
  }

  logger.debug('Polling active workflow watches', { count: watches.length });

  let completedCount = 0;

  for (const watch of watches) {
    try {
      const result = await checkAndHandleWorkflow(watch, collection);
      if (result) completedCount++;
    } catch (err) {
      logger.error('Error checking workflow', {
        submission_id: watch.submission_id,
        error: err.message
      });
    }
  }

  if (completedCount > 0) {
    logger.info('Workflow poll cycle completed', {
      checked: watches.length,
      completed: completedCount
    });
  }

  return { checked: watches.length, completed: completedCount };
}

/**
 * Check a single workflow watch against GoWe and handle completion.
 *
 * @returns {boolean} true if the workflow reached a terminal state
 */
async function checkAndHandleWorkflow(watch, collection) {
  const { submission_id, session_id, auth_token } = watch;

  // Fetch submission status from GoWe
  const submission = await fetchGoWeSubmission(submission_id, auth_token);
  if (!submission) {
    logger.warn('GoWe returned null for submission', { submission_id });
    return false;
  }

  const state = (submission.state || '').toUpperCase();

  // Extract external_ids from task-level data (e.g., BV-BRC job IDs)
  const externalIds = (submission.tasks || [])
    .filter(t => t.external_id)
    .map(t => ({
      task_id: t.id || '',
      step_id: t.step_id || '',
      external_id: t.external_id
    }));

  // Update last-known state and external_ids on every poll
  const updateFields = { gowe_state: state, last_checked: new Date() };
  if (externalIds.length > 0) {
    updateFields.external_ids = externalIds;
  }
  await collection.updateOne(
    { _id: watch._id },
    { $set: updateFields }
  );

  // Not terminal yet — keep watching
  if (!TERMINAL_STATES.has(state)) {
    return false;
  }

  // ----- Terminal state reached -----
  logger.info('Workflow reached terminal state', {
    submission_id,
    workflow_id: watch.workflow_id,
    state,
    session_id
  });

  // Build the completion payload from the GoWe submission data
  const status = state.toLowerCase();  // "completed", "failed", "cancelled"
  const workflowName = submission.workflow_name || submission.workflow_id || watch.workflow_id || submission_id;

  // Map GoWe step instances to the format expected by the webhook handler
  const steps = (submission.step_instances || []).map(si => ({
    step_name: si.step_id || si.name || 'unknown',
    app: si.cwl_step || '',
    status: (si.state || '').toLowerCase() === 'completed' ? 'succeeded'
          : (si.state || '').toLowerCase() === 'failed' ? 'failed'
          : (si.state || '').toLowerCase(),
    elapsed_time: si.elapsed_time || null,
    error_message: si.error || null
  }));

  const outputPaths = submission.output_paths || [];

  // Build the chat completion message (same logic as the /workflow-complete webhook)
  const completionMessage = buildCompletionMessage(status, workflowName, steps, outputPaths, externalIds);

  // Build message document
  const messageId = uuidv4();
  const message = {
    message_id: messageId,
    role: 'assistant',
    content: completionMessage,
    timestamp: new Date(),
    agent_metadata: {
      system_initiated: true,
      trigger: 'workflow_complete',
      workflow_id: watch.workflow_id || submission_id
    },
    workflow: {
      workflow_id: watch.workflow_id || submission_id,
      workflow_name: workflowName,
      status: status,
      output_paths: outputPaths,
      external_ids: externalIds,
      completed_at: submission.completed_at || new Date().toISOString(),
      steps: steps,
      step_count: steps.length,
      succeeded_steps: steps.filter(s => s.status === 'succeeded').length,
      failed_steps: steps.filter(s => s.status === 'failed').length
    },
    // Plan context so the frontend knows which plan step this relates to
    plan_context: {
      plan_id: watch.plan_id || null,
      step_id: watch.step_id || null,
      step_index: watch.step_index
    }
  };
  message.workflowData = message.workflow;

  // Write to MongoDB
  try {
    const session = await getChatSession(session_id);
    if (session) {
      await addMessagesToSession(session_id, [message]);
      logger.info('Workflow completion message written to session', {
        session_id,
        workflow_id: watch.workflow_id,
        submission_id
      });
    } else {
      logger.warn('Session not found for workflow completion', { session_id });
    }
  } catch (err) {
    logger.error('Failed to write workflow completion message', {
      session_id,
      error: err.message
    });
  }

  // Push SSE event to active streams
  const pushed = pushToSession(session_id, 'workflow_complete', {
    workflow_id: watch.workflow_id || submission_id,
    workflow_name: workflowName,
    status: status,
    output_paths: outputPaths,
    external_ids: externalIds,
    steps: steps,
    message_id: messageId,
    timestamp: new Date().toISOString(),
    plan_id: watch.plan_id || null,
    step_id: watch.step_id || null,
    step_index: watch.step_index
  });

  if (pushed > 0) {
    logger.info(`Pushed workflow_complete SSE to ${pushed} active stream(s)`, { session_id });
  }

  // Mark watch as completed
  await collection.updateOne(
    { _id: watch._id },
    {
      $set: {
        status: state === 'FAILED' ? 'failed' : 'completed',
        gowe_state: state,
        completed_at: new Date()
      }
    }
  );

  return true;
}

// ---------------------------------------------------------------------------
// GoWe API helper
// ---------------------------------------------------------------------------

/**
 * Fetch a submission from the GoWe workflow engine.
 *
 * @param {string} submissionId
 * @param {string|null} authToken
 * @returns {object|null} Submission data or null on error
 */
async function fetchGoWeSubmission(submissionId, authToken) {
  try {
    const url = `${GOWE_URL}/api/v1/submissions/${submissionId}`;
    const headers = {};
    if (authToken) {
      headers['Authorization'] = authToken;
    }

    const resp = await axios.get(url, {
      headers,
      timeout: GOWE_TIMEOUT_MS
    });

    // GoWe envelope: { status: "ok", data: { ... } }
    if (resp.data && resp.data.status === 'ok' && resp.data.data) {
      return resp.data.data;
    }

    // Some GoWe versions return data directly
    if (resp.data && resp.data.state) {
      return resp.data;
    }

    logger.warn('Unexpected GoWe response format', {
      submission_id: submissionId,
      status: resp.status,
      keys: Object.keys(resp.data || {})
    });
    return null;
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn('Submission not found in GoWe', { submission_id: submissionId });
    } else {
      logger.error('GoWe API error', {
        submission_id: submissionId,
        error: err.message,
        status: err.response?.status
      });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message builder (mirrors /workflow-complete webhook logic)
// ---------------------------------------------------------------------------

function buildCompletionMessage(status, workflowName, steps, outputPaths, externalIds) {
  // Build a job ID suffix for the message (shows BV-BRC job IDs if available)
  const jobIdSuffix = (externalIds && externalIds.length > 0)
    ? ` Job ID${externalIds.length > 1 ? 's' : ''}: ${externalIds.map(e => e.external_id).join(', ')}.`
    : '';

  if (status === 'completed' || status === 'succeeded') {
    const stepSummaries = steps
      .filter(s => s.status === 'succeeded')
      .map(s => {
        const elapsed = s.elapsed_time ? ` (${s.elapsed_time})` : '';
        return `${s.step_name} [${s.app}]${elapsed}`;
      })
      .join(', ');

    const pathList = outputPaths.length > 0
      ? outputPaths.join(', ')
      : 'your workspace';

    return `Your **${workflowName}** job has completed successfully.${jobIdSuffix} ` +
      `Steps completed: ${stepSummaries || 'none'}. ` +
      `Results are available in your workspace at ${pathList}.`;

  } else if (status === 'failed') {
    const failedStep = steps.find(s => s.status === 'failed');
    const failedName = failedStep ? failedStep.step_name : 'unknown step';
    const errorMsg = failedStep?.error_message || 'unknown error';

    const completedSteps = steps
      .filter(s => s.status === 'succeeded')
      .map(s => {
        const elapsed = s.elapsed_time ? ` (${s.elapsed_time})` : '';
        return `${s.step_name} [${s.app}]${elapsed}`;
      })
      .join(', ');

    return `Your **${workflowName}** job has failed.${jobIdSuffix} ` +
      `${failedName} encountered an error: ${errorMsg}.` +
      (completedSteps ? ` Successfully completed steps: ${completedSteps}.` : '');

  } else if (status === 'cancelled') {
    return `Your **${workflowName}** job was cancelled.${jobIdSuffix}`;

  } else {
    return `Your **${workflowName}** job finished with status: ${status}.${jobIdSuffix}`;
  }
}

// ---------------------------------------------------------------------------
// Public API — called by orchestratorClient.js to register a watch
// ---------------------------------------------------------------------------

/**
 * Register a workflow watch so the poller will monitor it for completion.
 *
 * @param {object} params
 * @param {string} params.submission_id  GoWe submission ID
 * @param {string} params.workflow_id    GoWe workflow ID
 * @param {string} params.session_id     Chat session ID
 * @param {string} params.plan_id        Planning agent plan ID
 * @param {string} params.step_id        Plan step ID
 * @param {number} params.step_index     Plan step index
 * @param {string} params.user_id        User ID
 * @param {string|null} params.auth_token  BV-BRC auth token for GoWe API
 */
async function registerWorkflowWatch(params) {
  const db = await connectToDatabase();
  const collection = db.collection('workflow_watches');

  const doc = {
    submission_id: params.submission_id,
    workflow_id: params.workflow_id || '',
    session_id: params.session_id,
    plan_id: params.plan_id || '',
    step_id: params.step_id || '',
    step_index: params.step_index ?? null,
    user_id: params.user_id || '',
    auth_token: params.auth_token || null,
    status: 'active',
    gowe_state: 'PENDING',
    created_at: new Date(),
    last_checked: null,
    completed_at: null
  };

  // Upsert by submission_id to avoid duplicates
  await collection.updateOne(
    { submission_id: params.submission_id },
    { $set: doc },
    { upsert: true }
  );

  logger.info('Workflow watch registered', {
    submission_id: params.submission_id,
    workflow_id: params.workflow_id,
    session_id: params.session_id,
    plan_id: params.plan_id
  });
}

// ---------------------------------------------------------------------------
// Queue event listeners
// ---------------------------------------------------------------------------

workflowMonitorQueue.on('completed', (job, result) => {
  if (result && (result.checked > 0 || result.completed > 0)) {
    logger.debug('Workflow poll job completed', {
      jobId: job.id,
      checked: result.checked,
      completed: result.completed
    });
  }
});

workflowMonitorQueue.on('failed', (job, error) => {
  logger.error('Workflow poll job failed', {
    jobId: job.id,
    error: error.message
  });
});

workflowMonitorQueue.on('error', (error) => {
  logger.error('Workflow monitor queue error', { error: error.message });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  registerWorkflowWatch,
  workflowMonitorQueue
};
