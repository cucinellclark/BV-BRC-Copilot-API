#!/usr/bin/env node
/**
 * purge-queues.js
 * 
 * Standalone script to purge all jobs from Bull queues.
 * This will remove all waiting, active, delayed, completed, and failed jobs.
 * 
 * Usage:
 *   node purge-queues.js
 *   node purge-queues.js --dry-run  (show what would be purged without actually purging)
 */

const Queue = require('bull');
const config = require('./config.json');

// Redis configuration
const redisConfig = {
    host: config.redis.host,
    port: config.redis.port
};

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-d');

/**
 * Purge a queue completely
 * @param {Queue} queue - Bull queue instance
 * @param {string} queueName - Name of the queue for logging
 * @returns {Promise<Object>} Statistics about what was purged
 */
async function purgeQueue(queue, queueName) {
    console.log(`\n[${queueName}] Checking queue status...`);
    
    // Get counts before purge
    const [waiting, active, delayed, completed, failed] = await Promise.all([
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
    
    console.log(`[${queueName}] Purging all jobs...`);
    
    try {
        // Use obliterate to completely remove all jobs and data
        // This is more thorough than clean() which only removes old jobs
        await queue.obliterate({ force: true });
        
        console.log(`[${queueName}] ✓ Successfully purged ${totalBefore} jobs`);
        
        return {
            queueName,
            purged: totalBefore,
            waiting,
            active,
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
        
        // Note: Active jobs cannot be cleaned while running
        if (active > 0) {
            console.log(`[${queueName}] ⚠ Warning: ${active} active job(s) cannot be purged while running`);
            console.log(`[${queueName}]    Wait for them to complete or restart the API with queue.enabled=false`);
        }
        
        console.log(`[${queueName}] ✓ Purged ${totalPurged} jobs (${active} active jobs remain)`);
        
        return {
            queueName,
            purged: totalPurged,
            waiting: 0,
            active, // Active jobs remain
            delayed: 0,
            completed: 0,
            failed: 0,
            total: totalPurged + active
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
    
    if (dryRun) {
        console.log('\n⚠ DRY RUN MODE - No jobs will be actually purged\n');
    } else {
        console.log('\n⚠ WARNING: This will permanently delete all jobs from the queues!');
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
        
        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('Purge Summary');
        console.log('='.repeat(60));
        
        let totalPurged = 0;
        let totalRemaining = 0;
        
        results.forEach(result => {
            console.log(`\n[${result.queueName}]:`);
            console.log(`  Purged: ${result.purged} jobs`);
            if (result.active > 0) {
                console.log(`  Remaining (active): ${result.active} jobs`);
                totalRemaining += result.active;
            }
            totalPurged += result.purged;
        });
        
        console.log(`\nTotal: ${totalPurged} jobs purged`);
        if (totalRemaining > 0) {
            console.log(`       ${totalRemaining} active jobs remain (will complete or can be stopped)`);
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

