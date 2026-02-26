#!/usr/bin/env node
/**
 * purge-queues.js
 * 
 * Standalone script to purge all jobs from Bull queues.
 * This will remove all waiting, active, delayed, completed, and failed jobs.
 * Purges queues based on the configured queue category (showcase or development).
 * 
 * Usage:
 *   node purge-queues.js
 *   node purge-queues.js --dry-run  (show what would be purged without actually purging)
 *   node purge-queues.js --stop-active  (stop/cancel active jobs before purging)
 */

const Queue = require('bull');
const config = require('./config.json');
const { getQueueRedisConfig, getQueueCategory } = require('./services/queueRedisConfig');

// Get Redis configuration based on queue category (showcase or development)
const redisConfig = getQueueRedisConfig();
const queueCategory = getQueueCategory();
const categoryName = queueCategory === 1 ? 'showcase' : 'development';

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-d');
const stopActive = args.includes('--stop-active') || args.includes('-s');

/**
 * Stop/cancel active jobs in a queue
 * @param {Queue} queue - Bull queue instance
 * @param {string} queueName - Name of the queue for logging
 * @returns {Promise<number>} Number of active jobs stopped
 */
async function stopActiveJobs(queue, queueName) {
    const activeJobs = await queue.getActive();
    
    if (activeJobs.length === 0) {
        console.log(`[${queueName}] No active jobs to stop`);
        return 0;
    }
    
    console.log(`[${queueName}] Stopping ${activeJobs.length} active job(s)...`);
    
    let stoppedCount = 0;
    for (const job of activeJobs) {
        try {
            await job.remove();
            stoppedCount++;
            console.log(`[${queueName}]   ✓ Stopped job ${job.id}`);
        } catch (error) {
            console.log(`[${queueName}]   ✗ Failed to stop job ${job.id}: ${error.message}`);
        }
    }
    
    console.log(`[${queueName}] ✓ Stopped ${stoppedCount} of ${activeJobs.length} active job(s)`);
    return stoppedCount;
}

/**
 * Purge a queue completely
 * @param {Queue} queue - Bull queue instance
 * @param {string} queueName - Name of the queue for logging
 * @returns {Promise<Object>} Statistics about what was purged
 */
async function purgeQueue(queue, queueName) {
    console.log(`\n[${queueName}] Checking queue status...`);
    
    // Get counts before purge
    let [waiting, active, delayed, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        queue.getCompletedCount(),
        queue.getFailedCount()
    ]);
    
    const totalBefore = waiting + active + delayed + completed + failed;
    
    console.log(`[${queueName}] Current queue state:`);
    console.log(`  - Waiting: ${waiting}`);
    console.log(`  - Active: ${active}`);
    console.log(`  - Delayed: ${delayed}`);
    console.log(`  - Completed: ${completed}`);
    console.log(`  - Failed: ${failed}`);
    console.log(`  - Total: ${totalBefore}`);
    
    if (dryRun) {
        console.log(`[${queueName}] DRY RUN - Would purge ${totalBefore} jobs`);
        return {
            queueName,
            purged: 0,
            waiting,
            active,
            delayed,
            completed,
            failed,
            total: totalBefore
        };
    }
    
    if (totalBefore === 0) {
        console.log(`[${queueName}] Queue is already empty, nothing to purge`);
        return {
            queueName,
            purged: 0,
            waiting,
            active,
            delayed,
            completed,
            failed,
            total: 0
        };
    }
    
    // Stop active jobs if requested
    let stoppedActive = 0;
    if (stopActive && active > 0 && !dryRun) {
        stoppedActive = await stopActiveJobs(queue, queueName);
        // Re-check active count after stopping
        const newActive = await queue.getActiveCount();
        active = newActive;
    }
    
    console.log(`[${queueName}] Purging all jobs...`);
    
    try {
        // Use obliterate to completely remove all jobs and data
        // This is more thorough than clean() which only removes old jobs
        await queue.obliterate({ force: true });
        
        console.log(`[${queueName}] ✓ Successfully purged ${totalBefore} jobs`);
        
        return {
            queueName,
            purged: totalBefore,
            stoppedActive,
            waiting,
            active: 0, // All jobs purged
            delayed,
            completed,
            failed,
            total: totalBefore
        };
    } catch (error) {
        // If obliterate fails (e.g., active jobs), try cleaning each state
        console.log(`[${queueName}] Attempting alternative purge method...`);
        
        let totalPurged = 0;
        
        // Clean waiting jobs (remove all, age 0)
        const waitingCleaned = await queue.clean(0, 'waiting');
        totalPurged += waitingCleaned.length;
        
        // Clean delayed jobs
        const delayedCleaned = await queue.clean(0, 'delayed');
        totalPurged += delayedCleaned.length;
        
        // Clean completed jobs
        const completedCleaned = await queue.clean(0, 'completed');
        totalPurged += completedCleaned.length;
        
        // Clean failed jobs
        const failedCleaned = await queue.clean(0, 'failed');
        totalPurged += failedCleaned.length;
        
        // Re-check active count
        const remainingActive = await queue.getActiveCount();
        
        // Note: Active jobs cannot be cleaned while running
        if (remainingActive > 0) {
            console.log(`[${queueName}] ⚠ Warning: ${remainingActive} active job(s) cannot be purged while running`);
            if (!stopActive) {
                console.log(`[${queueName}]    Use --stop-active flag to stop active jobs, or wait for them to complete`);
            } else {
                console.log(`[${queueName}]    Some active jobs could not be stopped`);
            }
        }
        
        console.log(`[${queueName}] ✓ Purged ${totalPurged} jobs (${remainingActive} active jobs remain)`);
        
        return {
            queueName,
            purged: totalPurged,
            stoppedActive,
            waiting: 0,
            active: remainingActive, // Active jobs remain
            delayed: 0,
            completed: 0,
            failed: 0,
            total: totalPurged + remainingActive
        };
    }
}

/**
 * Main execution
 */
async function main() {
    console.log('='.repeat(60));
    console.log('Queue Purge Script');
    console.log('='.repeat(60));
    console.log(`\nQueue Category: ${categoryName} (Redis DB: ${redisConfig.db})`);
    
    if (dryRun) {
        console.log('\n⚠ DRY RUN MODE - No jobs will be actually purged\n');
    } else {
        console.log('\n⚠ WARNING: This will permanently delete all jobs from the queues!');
        console.log(`   Target: ${categoryName} queues (Redis DB ${redisConfig.db})`);
        if (stopActive) {
            console.log('   Active jobs will be stopped before purging.');
        }
        console.log('   Press Ctrl+C within 5 seconds to cancel...\n');
        
        // Give user 5 seconds to cancel
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    const results = [];
    
    try {
        // Purge agent queue
        const agentQueue = new Queue('agent-operations', { redis: redisConfig });
        const agentResult = await purgeQueue(agentQueue, 'agent-operations');
        results.push(agentResult);
        await agentQueue.close();
        
        // Purge summary queue
        const summaryQueue = new Queue('chat-summary', { redis: redisConfig });
        const summaryResult = await purgeQueue(summaryQueue, 'chat-summary');
        results.push(summaryResult);
        await summaryQueue.close();
        
        // Purge session facts queue if it exists
        const factsQueue = new Queue('session-facts', { redis: redisConfig });
        const factsResult = await purgeQueue(factsQueue, 'session-facts');
        results.push(factsResult);
        await factsQueue.close();
        
        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('Purge Summary');
        console.log('='.repeat(60));
        
        let totalPurged = 0;
        let totalRemaining = 0;
        
        let totalStopped = 0;
        results.forEach(result => {
            console.log(`\n[${result.queueName}]:`);
            console.log(`  Purged: ${result.purged} jobs`);
            if (result.stoppedActive > 0) {
                console.log(`  Stopped (active): ${result.stoppedActive} jobs`);
                totalStopped += result.stoppedActive;
            }
            if (result.active > 0) {
                console.log(`  Remaining (active): ${result.active} jobs`);
                totalRemaining += result.active;
            }
            totalPurged += result.purged;
        });
        
        console.log(`\nTotal: ${totalPurged} jobs purged`);
        if (totalStopped > 0) {
            console.log(`       ${totalStopped} active jobs stopped`);
        }
        if (totalRemaining > 0) {
            console.log(`       ${totalRemaining} active jobs remain (use --stop-active to stop them)`);
        }
        
        if (dryRun) {
            console.log('\n✓ Dry run complete - no jobs were actually purged');
            console.log('  Run without --dry-run to actually purge the queues');
        } else {
            console.log('\n✓ Queue purge complete!');
        }
        
        process.exit(0);
    } catch (error) {
        console.error('\n✗ Error purging queues:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main();

