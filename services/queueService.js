// services/queueService.js

const Queue = require('bull');
const config = require('../config.json');
const { createLogger } = require('./logger');
const AgentOrchestrator = require('./agentOrchestrator');

// Initialize logger
const logger = createLogger('QueueService');

// Redis configuration from config.json
const redisConfig = {
    host: config.redis.host,
    port: config.redis.port
};

// Create Bull queue for agent operations
const agentQueue = new Queue('agent-operations', {
    redis: redisConfig,
    defaultJobOptions: {
        attempts: config.queue.maxRetries || 2,
        backoff: {
            type: 'exponential',
            delay: 2000 // Start with 2 second delay, doubles each retry
        },
        timeout: config.queue.jobTimeout || 600000, // 10 minutes default
        removeOnComplete: {
            age: config.redis.jobResultTTL || 3600, // Keep completed jobs for 1 hour
            count: 1000 // Keep last 1000 completed jobs
        },
        removeOnFail: {
            age: 86400 // Keep failed jobs for 24 hours
        }
    }
});

// Track job progress for status endpoint
const jobProgress = new Map();

/**
 * Process agent jobs
 */
agentQueue.process(config.queue.workerConcurrency || 3, async (job) => {
    const jobLogger = createLogger('AgentWorker', job.data.session_id);
    
    try {
        jobLogger.info('Starting agent job processing', {
            jobId: job.id,
            userId: job.data.user_id,
            query: job.data.query.substring(0, 100)
        });

        // Initialize progress tracking
        jobProgress.set(job.id, {
            status: 'active',
            currentIteration: 0,
            maxIterations: job.data.max_iterations || 8,
            currentTool: null,
            error: null,
            startedAt: new Date(),
            updatedAt: new Date()
        });

        // Update job progress
        await job.progress(10);

        // Execute agent loop (non-streaming, save results to DB)
        // Note: Progress tracking could be enhanced by modifying AgentOrchestrator
        // to accept a progress callback in the future
        const result = await AgentOrchestrator.executeAgentLoop({
            query: job.data.query,
            model: job.data.model,
            session_id: job.data.session_id,
            user_id: job.data.user_id,
            system_prompt: job.data.system_prompt,
            save_chat: job.data.save_chat,
            include_history: job.data.include_history,
            max_iterations: job.data.max_iterations,
            auth_token: job.data.auth_token,
            stream: false // Always non-streaming in queue
        });

        // Mark as completed
        await job.progress(100);
        
        const progress = jobProgress.get(job.id);
        if (progress) {
            progress.status = 'completed';
            progress.updatedAt = new Date();
            jobProgress.set(job.id, progress);
        }

        jobLogger.info('Agent job completed successfully', {
            jobId: job.id,
            iterations: result.iterations || 0
        });

        // Return minimal data (actual result is saved to DB)
        return {
            success: true,
            session_id: job.data.session_id,
            iterations: result.iterations || 0,
            completedAt: new Date()
        };

    } catch (error) {
        jobLogger.error('Agent job failed', {
            jobId: job.id,
            error: error.message,
            stack: error.stack
        });

        // Update progress with error
        const progress = jobProgress.get(job.id);
        if (progress) {
            progress.status = 'failed';
            progress.error = {
                message: error.message,
                type: error.name || 'Error'
            };
            progress.updatedAt = new Date();
            jobProgress.set(job.id, progress);
        }

        // Re-throw to mark job as failed
        throw error;
    }
});

/**
 * Event listeners for monitoring
 */
agentQueue.on('completed', (job, result) => {
    logger.info('Job completed', { 
        jobId: job.id, 
        userId: job.data.user_id,
        duration: Date.now() - job.timestamp
    });
});

agentQueue.on('failed', (job, error) => {
    logger.error('Job failed', { 
        jobId: job.id, 
        userId: job.data.user_id,
        error: error.message,
        attempts: job.attemptsMade
    });
});

agentQueue.on('stalled', (job) => {
    logger.warn('Job stalled', { 
        jobId: job.id,
        userId: job.data.user_id
    });
});

agentQueue.on('error', (error) => {
    logger.error('Queue error', { error: error.message });
});

/**
 * Add a new agent job to the queue
 * @param {Object} jobData - Job data containing query, model, user_id, etc.
 * @param {Object} options - Optional job options (priority, delay, etc.)
 * @returns {Object} Job object with job.id
 */
async function addAgentJob(jobData, options = {}) {
    logger.info('Adding agent job to queue', {
        userId: jobData.user_id,
        sessionId: jobData.session_id,
        priority: options.priority || 'normal'
    });

    const job = await agentQueue.add(jobData, {
        priority: options.priority || 0, // Lower number = higher priority
        ...options
    });

    // Initialize progress tracking
    jobProgress.set(job.id, {
        status: 'waiting',
        currentIteration: 0,
        maxIterations: jobData.max_iterations || 8,
        currentTool: null,
        error: null,
        startedAt: new Date(),
        updatedAt: new Date()
    });

    logger.info('Agent job added to queue', {
        jobId: job.id,
        userId: jobData.user_id
    });

    return job;
}

/**
 * Get job status and progress
 * @param {string} jobId - Bull job ID
 * @returns {Object} Job status object
 */
async function getJobStatus(jobId) {
    const job = await agentQueue.getJob(jobId);
    
    if (!job) {
        return {
            found: false,
            jobId
        };
    }

    const state = await job.getState();
    const progress = jobProgress.get(jobId) || {};
    
    return {
        found: true,
        jobId: job.id,
        status: state, // 'waiting', 'active', 'completed', 'failed', 'delayed'
        progress: {
            currentIteration: progress.currentIteration || 0,
            maxIterations: progress.maxIterations || 8,
            currentTool: progress.currentTool || null,
            percentage: job.progress() || 0
        },
        error: progress.error || (job.failedReason ? { message: job.failedReason } : null),
        timestamps: {
            created: job.timestamp,
            started: progress.startedAt || null,
            updated: progress.updatedAt || null,
            processed: job.processedOn || null,
            finished: job.finishedOn || null
        },
        attempts: {
            made: job.attemptsMade,
            remaining: job.opts.attempts - job.attemptsMade
        },
        data: {
            session_id: job.data.session_id,
            user_id: job.data.user_id
        }
    };
}

/**
 * Get queue statistics
 * @returns {Object} Queue statistics
 */
async function getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        agentQueue.getWaitingCount(),
        agentQueue.getActiveCount(),
        agentQueue.getCompletedCount(),
        agentQueue.getFailedCount(),
        agentQueue.getDelayedCount()
    ]);

    return {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed
    };
}

/**
 * Clean up old completed jobs
 * @param {number} graceMs - Grace period in milliseconds (default: 1 hour)
 */
async function cleanOldJobs(graceMs = 3600000) {
    const cleaned = await agentQueue.clean(graceMs, 'completed');
    logger.info('Cleaned old completed jobs', { count: cleaned.length });
    return cleaned;
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    logger.info('Shutting down queue service...');
    await agentQueue.close();
    jobProgress.clear();
    logger.info('Queue service shut down');
}

// Handle graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
    agentQueue,
    addAgentJob,
    getJobStatus,
    getQueueStats,
    cleanOldJobs,
    shutdown
};

