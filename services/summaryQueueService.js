const Queue = require('bull');
const config = require('../config.json');
const { createLogger } = require('./logger');
const { getSummaryBySessionId, getChatSession } = require('./dbUtils');
const { generateSummaryForSession } = require('./memory/conversationSummaryService');

const logger = createLogger('SummaryQueue');

const redisConfig = {
  host: config.redis.host,
  port: config.redis.port
};

const summaryQueue = new Queue('chat-summary', {
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

const workerConcurrency = config.conversation?.summarization?.worker_concurrency || 1;
const queueEnabled = config.queue?.enabled !== false && (config.conversation?.summarization?.enabled !== false);

logger.info('Summary queue worker initialized', {
  queueName: 'chat-summary',
  workerConcurrency,
  queueEnabled,
  summarizationEnabled: config.conversation?.summarization?.enabled || false
});

if (queueEnabled) {
  summaryQueue.process(workerConcurrency, async (job) => {
  const { session_id, user_id } = job.data;
  const jobStartTime = Date.now();
  
  logger.info('Processing summary job', {
    jobId: job.id,
    session_id,
    user_id,
    attemptsMade: job.attemptsMade
  });

  try {
    const result = await generateSummaryForSession(session_id, user_id);
    const duration = Date.now() - jobStartTime;
    
    logger.info('Summary job completed', {
      jobId: job.id,
      session_id,
      skipped: result.skipped,
      reason: result.reason,
      durationMs: duration
    });
    
    return { success: true, ...result };
  } catch (error) {
    const duration = Date.now() - jobStartTime;
    logger.error('Summary job failed', {
      jobId: job.id,
      session_id,
      user_id,
      error: error.message,
      stack: error.stack,
      attemptsMade: job.attemptsMade,
      willRetry: job.attemptsMade < (job.opts.attempts || 2),
      durationMs: duration
    });
    throw error;
  }
  });
  
  logger.info('Summary queue processor registered', {
    workerConcurrency,
    enabled: true
  });
} else {
  logger.warn('Summary queue processing is DISABLED - jobs will be queued but not processed automatically');
}

async function maybeQueueSummary({ session_id, user_id, messageCount = null }) {
  try {
    if (!config.conversation?.summarization?.enabled) {
      logger.debug('Summary queuing disabled in config', { session_id });
      return;
    }
    
    if (!session_id) {
      logger.debug('Skipping summary queue: no session_id');
      return;
    }

    logger.debug('Checking if summary should be queued', { session_id, user_id, messageCount });

    const summaryDoc = await getSummaryBySessionId(session_id);
    const summarizedCount = summaryDoc?.messages_summarized_count || 0;

    let totalMessages = messageCount;
    if (!Number.isFinite(totalMessages)) {
      const session = await getChatSession(session_id);
      totalMessages = session?.messages?.length || 0;
    }

    const minMessages = config.conversation?.summarization?.min_messages_for_summary || 10;
    if (totalMessages < minMessages) {
      logger.debug('Not queuing summary: below minimum message count', {
        session_id,
        totalMessages,
        minMessages
      });
      return;
    }

    const triggerEvery = config.conversation?.summarization?.trigger_every_n_messages || 20;
    const newMessagesSinceSummary = totalMessages - summarizedCount;
    
    if (newMessagesSinceSummary < triggerEvery) {
      logger.debug('Not queuing summary: not enough new messages', {
        session_id,
        totalMessages,
        summarizedCount,
        newMessagesSinceSummary,
        triggerEvery
      });
      return;
    }

    const jobId = `summary:${session_id}:${totalMessages}`;
    const priority = config.conversation?.summarization?.queue_priority || 5;
    
    logger.info('Queuing summary job', {
      session_id,
      user_id,
      jobId,
      totalMessages,
      summarizedCount,
      newMessagesSinceSummary,
      priority
    });

    await summaryQueue.add(
      { session_id, user_id },
      { jobId, priority }
    );

    logger.debug('Summary job queued successfully', { session_id, jobId });
  } catch (error) {
    logger.error('Failed to queue summary', {
      session_id,
      user_id,
      error: error.message,
      stack: error.stack
    });
    // Don't throw - this is a non-critical background operation
  }
}

// Queue event listeners for monitoring
summaryQueue.on('completed', (job, result) => {
  logger.info('Summary job completed', {
    jobId: job.id,
    sessionId: job.data.session_id,
    skipped: result.skipped,
    reason: result.reason,
    duration: Date.now() - job.timestamp
  });
});

summaryQueue.on('failed', (job, error) => {
  logger.error('Summary job failed', {
    jobId: job.id,
    sessionId: job.data.session_id,
    error: error.message,
    attempts: job.attemptsMade
  });
});

summaryQueue.on('stalled', (job) => {
  logger.warn('Summary job stalled', {
    jobId: job.id,
    sessionId: job.data.session_id
  });
});

summaryQueue.on('error', (error) => {
  logger.error('Summary queue error', { error: error.message, stack: error.stack });
});

module.exports = {
  maybeQueueSummary,
  summaryQueue
};

