const Queue = require('bull');
const config = require('../config.json');
const { createLogger } = require('./logger');
const { generateSessionFactsUpdate } = require('./memory/sessionFactsService');
const { getQueueCategory, getQueueRedisConfig } = require('./queueRedisConfig');

const logger = createLogger('SessionFactsQueue');

const redisConfig = getQueueRedisConfig();
const queueCategory = getQueueCategory();

const factsQueue = new Queue('session-facts', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: config.queue.maxRetries || 2,
    backoff: { type: 'exponential', delay: 2000 },
    timeout: config.queue.jobTimeout || 600000,
    removeOnComplete: {
      age: config.redis.jobResultTTL || 3600,
      count: 500
    },
    removeOnFail: { age: 86400 }
  }
});

const workerConcurrency = config.conversation?.facts?.worker_concurrency || 1;
const queueEnabled = config.queue?.enabled !== false && (config.conversation?.facts?.enabled !== false);

logger.info('Session facts queue worker initialized', {
  queueName: 'session-facts',
  workerConcurrency,
  queueEnabled,
  queueCategory,
  redisDb: redisConfig.db
});

if (queueEnabled) {
  factsQueue.process(workerConcurrency, async (job) => {
    const { session_id, user_id, user_query, toolId, parameters, result, model } = job.data;
    const jobStartTime = Date.now();

    logger.info('Processing session facts job', {
      jobId: job.id,
      session_id,
      toolId,
      attemptsMade: job.attemptsMade
    });

    try {
      const output = await generateSessionFactsUpdate({
        session_id,
        user_id,
        user_query,
        toolId,
        parameters,
        result,
        model
      });

      logger.info('Session facts job completed', {
        jobId: job.id,
        session_id,
        toolId,
        durationMs: Date.now() - jobStartTime
      });

      return { success: true, ...output };
    } catch (error) {
      logger.error('Session facts job failed', {
        jobId: job.id,
        session_id,
        toolId,
        error: error.message,
        stack: error.stack,
        attemptsMade: job.attemptsMade
      });
      throw error;
    }
  });
} else {
  logger.warn('Session facts queue processing is DISABLED - jobs will be queued but not processed automatically');
}

async function maybeQueueSessionFacts({
  session_id,
  user_id,
  user_query,
  toolId,
  parameters,
  result,
  model
}) {
  try {
    if (config.conversation?.facts?.enabled === false) {
      logger.debug('Session facts queuing disabled in config', { session_id });
      return;
    }
    if (!session_id) {
      logger.debug('Skipping session facts queue: no session_id');
      return;
    }

    const jobId = `facts:${session_id}:${Date.now()}`;
    const priority = config.conversation?.facts?.queue_priority || 5;

    await factsQueue.add(
      { session_id, user_id, user_query, toolId, parameters, result, model },
      { jobId, priority }
    );
  } catch (error) {
    logger.error('Failed to queue session facts', {
      session_id,
      toolId,
      error: error.message,
      stack: error.stack
    });
  }
}

factsQueue.on('error', (error) => {
  logger.error('Session facts queue error', { error: error.message, stack: error.stack });
});

module.exports = {
  maybeQueueSessionFacts,
  factsQueue
};

