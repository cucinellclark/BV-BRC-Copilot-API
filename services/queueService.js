// services/queueService.js

const Queue = require('bull');
const config = require('../config.json');
const { createLogger } = require('./logger');
const AgentOrchestrator = require('./agentOrchestrator');
const { getQueueCategory, getQueueRedisConfig } = require('./queueRedisConfig');

// Initialize logger
const logger = createLogger('QueueService');

// Redis configuration from config.json
const redisConfig = getQueueRedisConfig();
const queueCategory = getQueueCategory();

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

logger.info('Agent queue Redis category selected', {
    queueCategory,
    redisDb: redisConfig.db
});

// Track job progress for status endpoint
const jobProgress = new Map();

// Map to store streaming callbacks (shared across workers in same process)
const jobStreamCallbacks = new Map();
// Track cancellation requests for active jobs (cooperative cancellation)
const cancellationRequests = new Set();

/**
 * Safely emit to stream, handling connection errors
 * @param {string} jobId - Job ID
 * @param {string} eventType - SSE event type
 * @param {Object} data - Event data
 */
function safeStreamEmit(jobId, eventType, data) {
    const callback = jobStreamCallbacks.get(jobId);
    // Only log non-content events to reduce noise
    if (eventType !== 'final_response' && eventType !== 'content') {
        console.log('[QUEUE DEBUG] safeStreamEmit called - jobId:', jobId, 'eventType:', eventType, 'hasCallback:', !!callback);
    }
    if (!callback) {
        if (eventType !== 'final_response' && eventType !== 'content') {
            console.log('[QUEUE DEBUG] No callback found for jobId:', jobId);
        }
        return;
    }

    try {
        callback(eventType, data);
    } catch (error) {
        logger.warn('Stream callback failed', {
            jobId,
            eventType,
            error: error.message
        });
        // Remove dead callback
        jobStreamCallbacks.delete(jobId);
    }
}

/**
 * Process agent jobs
 * Only register processor if queue is enabled in config
 */
if (config.queue.enabled !== false) {
    agentQueue.process(config.queue.workerConcurrency || 3, async (job) => {
    const jobLogger = createLogger('AgentWorker', job.data.session_id);
    const jobId = job.id;
    const hasStreamCallback = jobStreamCallbacks.has(jobId);
    const cancellationKey = String(jobId);
    const isCancellationRequested = () => cancellationRequests.has(cancellationKey);

    try {
        jobLogger.info('Starting agent job processing', {
            jobId: job.id,
            userId: job.data.user_id,
            query: job.data.query.substring(0, 100),
            streaming: hasStreamCallback,
            has_images: Array.isArray(job.data.images) && job.data.images.length > 0,
            images_count: Array.isArray(job.data.images) ? job.data.images.length : 0
        });

        // Initialize progress tracking
        jobProgress.set(job.id, {
            status: 'active',
            currentIteration: 0,
            maxIterations: job.data.max_iterations || 3,
            currentTool: null,
            error: null,
            startedAt: new Date(),
            updatedAt: new Date()
        });

        // Emit started event
        safeStreamEmit(jobId, 'started', {
            job_id: jobId,
            session_id: job.data.session_id,
            message: 'Processing started',
            timestamp: new Date().toISOString()
        });

        await job.progress(10);

        // Create progress callback for iterations/tools
        const progressCallback = (iteration, tool, status) => {
            if (isCancellationRequested()) {
                const cancelError = new Error('Job cancelled by user');
                cancelError.name = 'JobCancelledError';
                cancelError.isCancelled = true;
                throw cancelError;
            }

            const progress = jobProgress.get(job.id);
            if (progress) {
                progress.currentIteration = iteration;
                progress.currentTool = tool;
                progress.status = status || 'active';
                progress.updatedAt = new Date();
                jobProgress.set(job.id, progress);
            }

            // Stream progress event
            const percentage = Math.min(90, 10 + (iteration / job.data.max_iterations) * 80);
            safeStreamEmit(jobId, 'progress', {
                iteration,
                max_iterations: job.data.max_iterations,
                tool,
                status,
                percentage: Math.floor(percentage),
                timestamp: new Date().toISOString()
            });

            job.progress(percentage);
        };

        // Get streaming callback if exists
        const streamCallback = jobStreamCallbacks.get(jobId);

        // Create response stream wrapper for agent if streaming
        const responseStream = streamCallback ? {
            write: (data) => {
                // Agent writes SSE format, parse and re-emit
                if (typeof data === 'string' && data.startsWith('event:')) {
                    const lines = data.split('\n');
                    const eventLine = lines.find(l => l.startsWith('event:'));
                    const dataLine = lines.find(l => l.startsWith('data:'));

                    if (eventLine && dataLine) {
                        const eventType = eventLine.replace('event:', '').trim();
                        const eventData = dataLine.replace('data:', '').trim();

                        try {
                            const parsed = JSON.parse(eventData);
                            safeStreamEmit(jobId, eventType, parsed);
                        } catch (e) {
                            // Not JSON, treat as plain text content
                            safeStreamEmit(jobId, 'content', { delta: eventData });
                        }
                    }
                }
            },
            end: () => {
                // Agent calls end() when done streaming
                // We don't actually end here - we'll send 'done' event later
            },
            writableEnded: false,
            flushHeaders: () => {} // No-op
        } : null;

        // Execute agent loop with streaming support
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
            workspace_items: job.data.workspace_items,
            selected_jobs: job.data.selected_jobs,
            images: job.data.images,
            stream: !!streamCallback,
            responseStream: responseStream,
            progressCallback: progressCallback,
            shouldCancel: isCancellationRequested
        });

        if (isCancellationRequested()) {
            const cancelError = new Error('Job cancelled by user');
            cancelError.name = 'JobCancelledError';
            cancelError.isCancelled = true;
            throw cancelError;
        }

        await job.progress(100);

        const progress = jobProgress.get(job.id);
        if (progress) {
            progress.status = 'completed';
            progress.updatedAt = new Date();
            jobProgress.set(job.id, progress);
        }

        // Emit completion event
        safeStreamEmit(jobId, 'done', {
            job_id: jobId,
            session_id: job.data.session_id,
            iterations: result.iterations || 0,
            tools_used: result.toolsUsed || [],
            duration_seconds: Math.floor((Date.now() - job.timestamp) / 1000),
            timestamp: new Date().toISOString()
        });

        jobLogger.info('Agent job completed successfully', {
            jobId: job.id,
            iterations: result.iterations || 0
        });

        // Clean up callback
        jobStreamCallbacks.delete(jobId);
        cancellationRequests.delete(cancellationKey);

        return {
            success: true,
            session_id: job.data.session_id,
            iterations: result.iterations || 0,
            completedAt: new Date()
        };

    } catch (error) {
        if (error && error.isCancelled) {
            jobLogger.info('Agent job cancelled', {
                jobId: job.id,
                message: error.message
            });

            const progress = jobProgress.get(job.id);
            if (progress) {
                progress.status = 'cancelled';
                progress.error = null;
                progress.updatedAt = new Date();
                jobProgress.set(job.id, progress);
            }

            safeStreamEmit(jobId, 'cancelled', {
                job_id: jobId,
                message: 'Job cancelled by user',
                timestamp: new Date().toISOString()
            });
            safeStreamEmit(jobId, 'done', {
                job_id: jobId,
                session_id: job.data.session_id,
                cancelled: true,
                message: 'Job cancelled by user',
                timestamp: new Date().toISOString()
            });

            // Prevent retries for cancelled jobs.
            await job.discard();
            jobStreamCallbacks.delete(jobId);
            cancellationRequests.delete(cancellationKey);

            return {
                success: false,
                cancelled: true,
                session_id: job.data.session_id,
                completedAt: new Date()
            };
        }

        jobLogger.error('Agent job failed', {
            jobId: job.id,
            error: error.message,
            stack: error.stack
        });

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

        // Emit error event
        safeStreamEmit(jobId, 'error', {
            job_id: jobId,
            error: error.message,
            retry_attempt: job.attemptsMade,
            will_retry: job.attemptsMade < job.opts.attempts,
            timestamp: new Date().toISOString()
        });

        // Clean up callback
        jobStreamCallbacks.delete(jobId);
        cancellationRequests.delete(cancellationKey);

        throw error;
    }
    });

    logger.info('Agent queue processor registered', {
        workerConcurrency: config.queue.workerConcurrency || 3,
        enabled: true
    });
} else {
    logger.warn('Agent queue processing is DISABLED in config - jobs will be queued but not processed automatically');
}

/**
 * Event listeners for monitoring
 */
agentQueue.on('completed', (job, result) => {
    const progress = jobProgress.get(job.id);
    if (progress?.status === 'cancelled') {
        logger.info('Job cancelled', {
            jobId: job.id,
            userId: job.data.user_id,
            duration: Date.now() - job.timestamp
        });
        return;
    }

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
 * @param {Object} options - Optional job options
 * @param {Function} options.streamCallback - Optional streaming callback(eventType, data)
 * @param {Number} options.priority - Job priority (default: 0)
 * @returns {Object} Job object with job.id
 */
async function addAgentJob(jobData, options = {}) {
    const { streamCallback = null, priority = 0, ...bullOptions } = options;

    logger.info('Adding agent job to queue', {
        userId: jobData.user_id,
        sessionId: jobData.session_id,
        streaming: !!streamCallback,
        priority
    });

    const job = await agentQueue.add(jobData, {
        priority,
        ...bullOptions
    });

    // Store callback reference for worker to access
    if (streamCallback) {
        jobStreamCallbacks.set(job.id, streamCallback);

        // Emit queued event immediately
        safeStreamEmit(job.id, 'queued', {
            job_id: job.id,
            session_id: jobData.session_id,
            message: 'Job queued successfully',
            timestamp: new Date().toISOString()
        });
    }

    // Initialize progress tracking
    jobProgress.set(job.id, {
        status: 'waiting',
        currentIteration: 0,
        maxIterations: jobData.max_iterations || 3,
        currentTool: null,
        error: null,
        startedAt: new Date(),
        updatedAt: new Date()
    });
    cancellationRequests.delete(String(job.id));

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
    const effectiveStatus = progress.status || state;

    return {
        found: true,
        jobId: job.id,
        status: effectiveStatus, // includes local cooperative states like 'cancelling'/'cancelled'
        progress: {
            currentIteration: progress.currentIteration || 0,
            maxIterations: progress.maxIterations || 3,
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
 * Register or update streaming callback for an existing job
 * Used for reconnection support
 * @param {string} jobId - Job ID
 * @param {Function} callback - Streaming callback(eventType, data)
 */
function registerStreamCallback(jobId, callback) {
    logger.info('Registering stream callback for job', { jobId });
    jobStreamCallbacks.set(jobId, callback);
}

/**
 * Abort/cancel a job
 * @param {string} jobId - Bull job ID
 * @returns {Object} Result object with success status
 */
async function abortJob(jobId) {
    const job = await agentQueue.getJob(jobId);

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
            // Update progress tracking
            const progress = jobProgress.get(jobId);
            if (progress) {
                progress.status = 'cancelled';
                progress.updatedAt = new Date();
                jobProgress.set(jobId, progress);
            }

            safeStreamEmit(jobId, 'cancelled', {
                job_id: jobId,
                message: 'Job cancelled by user',
                timestamp: new Date().toISOString()
            });

            // Remove waiting/delayed jobs
            await job.remove();
            jobStreamCallbacks.delete(jobId);
            cancellationRequests.delete(String(jobId));
            logger.info('Job removed from queue', { jobId, state });
            return {
                found: true,
                success: true,
                message: 'Job cancelled successfully',
                jobId,
                previousState: state
            };
        } else if (state === 'active') {
            // Cooperative cancellation for active jobs; worker exits at safe checkpoints.
            cancellationRequests.add(String(jobId));
            const progress = jobProgress.get(jobId);
            if (progress) {
                progress.status = 'cancelling';
                progress.updatedAt = new Date();
                jobProgress.set(jobId, progress);
            }

            safeStreamEmit(jobId, 'cancel_requested', {
                job_id: jobId,
                message: 'Cancellation requested',
                timestamp: new Date().toISOString()
            });

            logger.info('Active job cancellation requested', { jobId });
            return {
                found: true,
                success: true,
                accepted: true,
                message: 'Cancellation requested for active job',
                jobId,
                previousState: state,
                note: 'Job will stop at the next safe checkpoint'
            };
        } else if (state === 'completed' || state === 'failed') {
            // Already finished, can't cancel but can remove
            await job.remove();
            jobStreamCallbacks.delete(jobId);
            cancellationRequests.delete(String(jobId));
            logger.info('Finished job removed', { jobId, state });
            return {
                found: true,
                success: true,
                message: 'Job already finished, removed from history',
                jobId,
                previousState: state
            };
        } else {
            // Unknown state, try to remove anyway
            await job.remove();
            jobStreamCallbacks.delete(jobId);
            cancellationRequests.delete(String(jobId));
            logger.info('Job removed (unknown state)', { jobId, state });
            return {
                found: true,
                success: true,
                message: 'Job removed',
                jobId,
                previousState: state
            };
        }
    } catch (error) {
        logger.error('Failed to abort job', {
            jobId,
            error: error.message,
            state
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

/**
 * Graceful shutdown
 */
async function shutdown() {
    logger.info('Shutting down queue service...');
    await agentQueue.close();
    jobProgress.clear();
    jobStreamCallbacks.clear();
    cancellationRequests.clear();
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
    registerStreamCallback,
    abortJob,
    shutdown
};

