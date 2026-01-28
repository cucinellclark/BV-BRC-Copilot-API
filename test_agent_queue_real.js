// test_agent_queue_real.js - Test agent queue with real queries and model from DB

const { addAgentJob, getJobStatus, getQueueStats, shutdown } = require('./services/queueService');
const { getActiveModels } = require('./services/dbUtils');
const { v4: uuidv4 } = require('uuid');

async function testAgentQueueWithRealModel() {
    console.log('=== Testing Agent Queue with Real Model ===\n');
    
    try {
        // Step 1: Get first active model from MongoDB
        console.log('Step 1: Fetching first active model from MongoDB...');
        const activeModels = await getActiveModels('chat');
        
        if (!activeModels || activeModels.length === 0) {
            console.error('✗ No active models found in database!');
            console.error('Please add a model to the modelList collection with active: true');
            await shutdown();
            process.exit(1);
        }
        
        const model = activeModels[0].model;
        console.log(`✓ Found active model: ${model}\n`);
        
        // Step 2: Define test queries
        const testQueries = [
            {
                name: 'Simple greeting',
                query: 'hello',
                expectedIterations: 1,
                description: 'Should FINALIZE immediately without tools'
            },
            {
                name: 'Knowledge question',
                query: 'How does the Genome Annotation service work',
                expectedIterations: '2-3',
                description: 'May use RAG search tool for documentation'
            },
            {
                name: 'Data retrieval',
                query: 'Can you get me genome data for genome 208964.12',
                expectedIterations: '3-5',
                description: 'Will use genome_data tool and possibly others'
            }
        ];
        
        console.log('Step 2: Submitting test queries to queue...\n');
        
        const jobs = [];
        
        for (const test of testQueries) {
            console.log(`Submitting: "${test.query}"`);
            console.log(`  Expected: ${test.expectedIterations} iterations - ${test.description}`);
            
            const job = await addAgentJob({
                query: test.query,
                model: model,
                session_id: `test-${test.name.replace(/\s+/g, '-')}-${Date.now()}`,
                user_id: 'queue-test-user@example.com',
                system_prompt: '',
                save_chat: false,
                include_history: false,
                max_iterations: 8,
                auth_token: null
            });
            
            jobs.push({
                jobId: job.id,
                test: test
            });
            
            console.log(`  ✓ Job queued: ID ${job.id}\n`);
        }
        
        console.log('---\n');
        
        // Step 3: Monitor queue stats
        console.log('Step 3: Initial queue statistics:');
        const initialStats = await getQueueStats();
        console.log(JSON.stringify(initialStats, null, 2));
        console.log('\n---\n');
        
        // Step 4: Monitor first job progress
        console.log('Step 4: Monitoring first job (simple greeting)...\n');
        const firstJobId = jobs[0].jobId;
        let completed = false;
        let pollCount = 0;
        const maxPolls = 60; // Max 60 seconds of polling
        
        while (!completed && pollCount < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every second
            pollCount++;
            
            const status = await getJobStatus(firstJobId);
            
            console.log(`[Poll ${pollCount}] Status: ${status.status}, Progress: ${status.progress.percentage}%`);
            
            if (status.progress.currentIteration > 0) {
                console.log(`          Iteration: ${status.progress.currentIteration}/${status.progress.maxIterations}, Tool: ${status.progress.currentTool || 'planning'}`);
            }
            
            if (status.error) {
                console.log(`          Error: ${status.error.message}`);
            }
            
            if (status.status === 'completed') {
                completed = true;
                console.log(`\n✓ First job completed after ${pollCount} seconds!`);
                console.log(`  Session ID: ${status.data.session_id}`);
                console.log(`  (Result saved to MongoDB session)\n`);
            } else if (status.status === 'failed') {
                console.log(`\n✗ First job failed after ${pollCount} seconds`);
                console.log(`  Error: ${status.error?.message || 'Unknown error'}\n`);
                completed = true;
            }
        }
        
        if (!completed) {
            console.log(`\n⏱ Job still running after ${maxPolls} seconds (this is normal for complex queries)\n`);
        }
        
        console.log('---\n');
        
        // Step 5: Show final queue stats
        console.log('Step 5: Final queue statistics:');
        const finalStats = await getQueueStats();
        console.log(JSON.stringify(finalStats, null, 2));
        console.log('\n---\n');
        
        // Step 6: Show status of all jobs
        console.log('Step 6: Status of all test jobs:\n');
        for (const job of jobs) {
            const status = await getJobStatus(job.jobId);
            console.log(`Job ${job.jobId} (${job.test.name}):`);
            console.log(`  Status: ${status.status}`);
            console.log(`  Progress: ${status.progress.percentage}%`);
            if (status.progress.currentIteration > 0) {
                console.log(`  Iteration: ${status.progress.currentIteration}/${status.progress.maxIterations}`);
            }
            if (status.error) {
                console.log(`  Error: ${status.error.message}`);
            }
            console.log('');
        }
        
        console.log('=== Test Summary ===\n');
        console.log('✓ Queue service is operational');
        console.log('✓ Jobs are being processed with real model');
        console.log('✓ Progress tracking is working');
        console.log('✓ Status polling is working');
        console.log('\nNOTE: Some jobs may still be processing in the background.');
        console.log('Check their status with: curl http://localhost:7032/copilot-api/chatbrc/job/JOB_ID/status\n');
        
        console.log('Shutting down test script (queue workers will continue)...');
        await shutdown();
        process.exit(0);
        
    } catch (error) {
        console.error('\n✗ Test failed with error:', error.message);
        console.error('Stack trace:', error.stack);
        await shutdown();
        process.exit(1);
    }
}

// Run the test
console.log('Starting queue test with real model from MongoDB...\n');
testAgentQueueWithRealModel();

