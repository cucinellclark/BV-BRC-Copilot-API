// services/ragQueueService.js

const Queue = require('bull');
const config = require('../config.json');
const { createLogger } = require('./logger');
const { getQueueRedisConfig } = require('./queueRedisConfig');
const ChatService = require('./chatService');

const logger = createLogger('RagQueueService');

const redisConfig = getQueueRedisConfig();

const ragQueue = new Queue('rag-operations', {
    redis: redisConfig,
    defaultJobOptions: {
        attempts: config.queue.maxRetries || 2,
        backoff: {
            type: 'exponential',
            delay: 2000
        },
        timeout: config.queue.jobTimeout || 600000,
        removeOnComplete: {
            age: config.redis.jobResultTTL || 3600,
            count: 1000
        },
        removeOnFail: {
            age: 86400
        }
    }
});

logger.info('RAG queue Redis db selected', {
    redisDb: redisConfig.db
});

const jobProgress = new Map();
const jobStreamCallbacks = new Map();

function safeStreamEmit(jobId, eventType, data) {
    const callback = jobStreamCallbacks.get(jobId);
    if (!callback) return;
    try {
        callback(eventType, data);
    } catch (error) {
        logger.warn('RAG stream callback failed', {
            jobId,
            eventType,
            error: error.message
        });
        jobStreamCallbacks.delete(jobId);
    }
}

if (config.queue.enabled !== false) {
    ragQueue.process(config.queue.workerConcurrency || 3, async (job) => {
        const jobId = job.id;
        const jobLogger = createLogger('RagWorker', job.data.session_id);

        try {
            jobLogger.info('Starting RAG job processing', {
                jobId,
                userId: job.data.user_id,
                sessionId: job.data.session_id,
                rag_db: job.data.rag_db
            });

            jobProgress.set(jobId, {
                status: 'active',
                error: null,
                startedAt: new Date(),
                updatedAt: new Date()
            });

            safeStreamEmit(jobId, 'started', {
                job_id: jobId,
                session_id: job.data.session_id,
                message: 'Processing started',
                timestamp: new Date().toISOString()
            });

            await job.progress(20);
            const response = await ChatService.handleRagStreamRequest({
                query: job.data.query,
                rag_db: job.data.rag_db,
                user_id: job.data.user_id,
                model: job.data.model,
                num_docs: job.data.num_docs,
                session_id: job.data.session_id,
                save_chat: job.data.save_chat,
                onChunk: (chunk) => {
                    safeStreamEmit(jobId, 'final_response', {
                        job_id: jobId,
                        chunk
                    });
                }
            });
            await job.progress(100);

            const progress = jobProgress.get(jobId);
            if (progress) {
                progress.status = 'completed';
                progress.updatedAt = new Date();
                jobProgress.set(jobId, progress);
            }

            safeStreamEmit(jobId, 'done', {
                job_id: jobId,
                session_id: job.data.session_id,
                timestamp: new Date().toISOString()
            });

            jobStreamCallbacks.delete(jobId);

            return {
                success: true,
                session_id: job.data.session_id,
                response,
                completedAt: new Date()
            };
        } catch (error) {
            jobLogger.error('RAG job failed', {
                jobId,
                error: error.message,
                stack: error.stack
            });

            const progress = jobProgress.get(jobId);
            if (progress) {
                progress.status = 'failed';
                progress.error = {
                    message: error.message,
                    type: error.name || 'Error'
                };
                progress.updatedAt = new Date();
                jobProgress.set(jobId, progress);
            }

            safeStreamEmit(jobId, 'error', {
                job_id: jobId,
                error: error.message,
                retry_attempt: job.attemptsMade,
                will_retry: job.attemptsMade < job.opts.attempts,
                timestamp: new Date().toISOString()
            });
            jobStreamCallbacks.delete(jobId);
            throw error;
        }
    });

    logger.info('RAG queue processor registered', {
        workerConcurrency: config.queue.workerConcurrency || 3,
        enabled: true
    });
} else {
    logger.warn('RAG queue processing is DISABLED in config - jobs will be queued but not processed automatically');
}

async function addRagJob(jobData, options = {}) {
    const { streamCallback = null, priority = 0, ...bullOptions } = options;

    const job = await ragQueue.add(jobData, {
        priority,
        ...bullOptions
    });

    if (streamCallback) {
        jobStreamCallbacks.set(job.id, streamCallback);
        safeStreamEmit(job.id, 'queued', {
            job_id: job.id,
            session_id: jobData.session_id,
            message: 'RAG job queued successfully',
            timestamp: new Date().toISOString()
        });
    }

    jobProgress.set(job.id, {
        status: 'waiting',
        error: null,
        startedAt: new Date(),
        updatedAt: new Date()
    });

    logger.info('RAG job added to queue', {
        jobId: job.id,
        userId: jobData.user_id,
        sessionId: jobData.session_id,
        streaming: !!streamCallback
    });

    return job;
}

async function getRagJobStatus(jobId) {
    const job = await ragQueue.getJob(jobId);

    if (!job) {
        return {
            found: false,
            jobId
        };
    }

    const state = await job.getState();
    const progress = jobProgress.get(jobId) || {};
    const effectiveStatus = progress.status || state;

    return {
        found: true,
        jobId: job.id,
        status: effectiveStatus,
        progress: {
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
            user_id: job.data.user_id,
            rag_db: job.data.rag_db
        },
        result: job.returnvalue || null
    };
}

async function getRagQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        ragQueue.getWaitingCount(),
        ragQueue.getActiveCount(),
        ragQueue.getCompletedCount(),
        ragQueue.getFailedCount(),
        ragQueue.getDelayedCount()
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

function registerRagStreamCallback(jobId, callback) {
    jobStreamCallbacks.set(jobId, callback);
}

async function abortRagJob(jobId) {
    const job = await ragQueue.getJob(jobId);
    if (!job) {
        return {
            found: false,
            success: false,
            message: 'Job not found',
            jobId
        };
    }

    const state = await job.getState();
    try {
        if (state === 'waiting' || state === 'delayed') {
            await job.remove();
            jobStreamCallbacks.delete(jobId);
            const progress = jobProgress.get(jobId);
            if (progress) {
                progress.status = 'cancelled';
                progress.updatedAt = new Date();
                jobProgress.set(jobId, progress);
            }
            return {
                found: true,
                success: true,
                message: 'Job cancelled successfully',
                jobId,
                previousState: state
            };
        }

        if (state === 'active') {
            return {
                found: true,
                success: false,
                message: 'Active RAG jobs cannot be cancelled mid-flight',
                jobId,
                previousState: state
            };
        }

        await job.remove();
        jobStreamCallbacks.delete(jobId);
        return {
            found: true,
            success: true,
            message: 'Job removed',
            jobId,
            previousState: state
        };
    } catch (error) {
        logger.error('Failed to abort RAG job', {
            jobId,
            error: error.message
        });
        return {
            found: true,
            success: false,
            message: 'Failed to cancel job',
            error: error.message,
            jobId,
            previousState: state
        };
    }
}

async function shutdownRagQueue() {
    logger.info('Shutting down RAG queue service...');
    await ragQueue.close();
    jobProgress.clear();
    jobStreamCallbacks.clear();
    logger.info('RAG queue service shut down');
}

process.on('SIGTERM', shutdownRagQueue);
process.on('SIGINT', shutdownRagQueue);

module.exports = {
    ragQueue,
    addRagJob,
    getRagJobStatus,
    getRagQueueStats,
    registerRagStreamCallback,
    abortRagJob,
    shutdownRagQueue
};

