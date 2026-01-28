#!/usr/bin/env node
// test_concurrency.js - Test API concurrency with multiple users
// Tests both data queries (genome features) and service questions
//
// Usage:
//   node test_concurrency.js
//   CONCURRENT_USERS=10 REQUESTS_PER_USER=5 node test_concurrency.js
//   USE_STREAMING=false node test_concurrency.js
//   API_URL=http://localhost:7032/copilot-api/chatbrc node test_concurrency.js
//
// Environment Variables:
//   API_URL - API base URL (default: http://localhost:7032/copilot-api/chatbrc)
//   MODEL - Model to use (default: RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16)
//   CONCURRENT_USERS - Number of concurrent users (default: 5)
//   REQUESTS_PER_USER - Number of requests per user (default: 3)
//   USE_STREAMING - Use streaming responses (default: true)

const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Create a new agent for each request to avoid connection pooling issues
const createAgent = () => new http.Agent({ 
    keepAlive: false 
});

// Read auth token from ~/.patric_token
const tokenPath = path.join(os.homedir(), '.patric_token');
let authToken = '';

try {
    authToken = fs.readFileSync(tokenPath, 'utf8').trim();
    console.log('✓ Auth token loaded from ~/.patric_token\n');
} catch (error) {
    console.error('✗ Failed to read auth token from ~/.patric_token');
    console.error('  Error:', error.message);
    console.error('  Note: Using empty token (will fail if auth is required)');
}

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:7032/copilot-api/chatbrc';
const MODEL = process.env.MODEL || 'RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16';
const CONCURRENT_USERS = parseInt(process.env.CONCURRENT_USERS || '5', 10);
const REQUESTS_PER_USER = parseInt(process.env.REQUESTS_PER_USER || '3', 10);
const USE_STREAMING = process.env.USE_STREAMING !== 'false'; // Default to true

// Genome IDs for data queries
const GENOME_IDS = [
    "471.85", "28090.142", "28090.144", "28090.145", "28090.149", "28090.150",
    "28090.143", "471.87", "471.90", "471.91", "471.89", "2053287.10",
    "1530123.105", "2726727.3", "2726727.4", "2865162.3", "1530123.104",
    "165433.100", "165433.101", "165433.104", "165433.105", "165433.106",
    "165433.108", "165433.102", "165433.107", "2726727.6", "40216.34",
    "40216.35", "40216.36", "40215.40", "472.26", "472.27", "3138069.4",
    "40214.34", "40214.35", "1221301.6", "1217662.4", "40215.39", "981334.8",
    "903900.4", "981334.9", "1330047.7", "470.4458", "1242245.16", "1242245.13",
    "1242245.12", "1242245.10", "1242245.14", "1242245.11", "1242245.15",
    "28090.67", "28090.66", "470.4439", "980514.12", "509173.26", "52133.22",
    "470.4442", "1400867.12", "470.4441", "400667.79", "1280052.7", "405416.48",
    "509173.29", "1096997.11", "1096995.11", "61312.6", "1280052.4", "889738.19",
    "903900.7", "471.35", "1809055.6", "1809055.8", "1809055.5", "470.4414",
    "1086014.5", "889738.18", "886890.7", "1197884.8", "470.4461", "470.4462",
    "28090.64", "28090.63", "28090.68", "487316.24", "487316.25", "487316.19",
    "487316.21", "487316.23", "156739.4", "1407071.5", "1407071.4", "470.4444",
    "1280052.11", "1280052.3", "1096995.12", "1280052.12", "1400867.11",
    "1096996.10", "28090.70", "1280052.5"
];

// Service names for service questions
const SERVICES = [
    // Genomics
    "Genome Assembly", "Genome Annotation", "Comprehensive Genome Analysis",
    "BLAST", "Primer Design", "Similar Genome Finder", "Genome Alignment",
    "Variation Analysis", "Tn-Seq Analysis",
    // Metagenomics
    "Taxonomic Classification", "Metagenomic Binning", "Metagenomic Read Mapping",
    // Phylogenomics
    "Bacterial Genome Tree", "Viral Genome Tree", "Gene/Protein Tree",
    "Core Genome MLST", "Whole Genome SNP Analysis",
    // Transcriptomics
    "RNA-Seq Analysis", "Expression Import",
    // Protein Tools
    "MSA and SNP Analysis", "Meta-CATS", "Proteome Comparison",
    "Protein Family Sorter", "Comparative Systems", "Docking",
    // Utilities
    "Fastq Utilities", "ID Mapper",
    // Viral Tools
    "SARS-CoV-2 Genome Analysis", "SARS-CoV-2 Wastewater Analysis",
    "Influenza Sequence Submission", "Influenza HA Subtype Conversion",
    "Subspecies Classification", "Viral Assembly",
    // Outbreak Tracker
    "Measles 2025", "Mpox 2024", "Influenza H5N1 2024", "SARS-CoV-2"
];

// Statistics tracking
const stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalResponseTime: 0,
    minResponseTime: Infinity,
    maxResponseTime: 0,
    errors: [],
    startTime: null,
    endTime: null
};

// Generate a random user ID
function generateUserId(userIndex) {
    return `testuser${userIndex}@test.bvbrc.org`;
}

// Generate a random session ID
function generateSessionId(userIndex, requestIndex) {
    return `test-session-${userIndex}-${requestIndex}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Get a random genome ID for data queries
function getRandomGenomeId() {
    return GENOME_IDS[Math.floor(Math.random() * GENOME_IDS.length)];
}

// Get a random service name for service questions
function getRandomService() {
    return SERVICES[Math.floor(Math.random() * SERVICES.length)];
}

// Generate a query (alternate between data queries and service questions)
function generateQuery(requestIndex) {
    if (requestIndex % 2 === 0) {
        // Data query
        const genomeId = getRandomGenomeId();
        return `Get me the genome features for genome with genome_id ${genomeId}`;
    } else {
        // Service question
        const service = getRandomService();
        return `How do I use ${service}?`;
    }
}

// Handle streaming response
async function handleStreamingResponse(response, userIndex, requestIndex) {
    const startTime = Date.now();
    let buffer = '';
    let contentReceived = false;
    let doneReceived = false;
    let errorReceived = false;
    
    try {
        for await (const chunk of response.body) {
            buffer += chunk.toString();
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (!line.trim() || line.startsWith(':')) continue;
                
                const eventMatch = line.match(/event: (\w+)/);
                const dataMatch = line.match(/data: (.+)/);
                
                if (eventMatch && dataMatch) {
                    const eventType = eventMatch[1];
                    const data = JSON.parse(dataMatch[1]);
                    
                    if (eventType === 'content' || eventType === 'final_response') {
                        contentReceived = true;
                    }
                    
                    if (eventType === 'done') {
                        doneReceived = true;
                        const responseTime = Date.now() - startTime;
                        updateStats(true, responseTime);
                        return { success: true, responseTime, data };
                    }
                    
                    if (eventType === 'error') {
                        errorReceived = true;
                        const responseTime = Date.now() - startTime;
                        updateStats(false, responseTime, data.error || 'Unknown error');
                        return { success: false, responseTime, error: data.error || 'Unknown error' };
                    }
                }
            }
        }
        
        // Stream ended without done/error
        const responseTime = Date.now() - startTime;
        updateStats(doneReceived, responseTime, doneReceived ? null : 'Stream ended unexpectedly');
        return { success: doneReceived, responseTime, error: doneReceived ? null : 'Stream ended unexpectedly' };
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        updateStats(false, responseTime, error.message);
        return { success: false, responseTime, error: error.message };
    }
}

// Handle non-streaming response (job queued)
async function handleNonStreamingResponse(response, userIndex, requestIndex) {
    const startTime = Date.now();
    
    try {
        const data = await response.json();
        
        if (response.status === 202 && data.job_id) {
            // Job queued successfully - poll for completion
            const jobId = data.job_id;
            const pollInterval = data.poll_interval_ms || 1000;
            const maxWait = 600000; // 10 minutes max
            const endTime = startTime + maxWait;
            
            while (Date.now() < endTime) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
                const statusResponse = await fetch(`${API_URL}/job/${jobId}/status`, {
                    method: 'GET',
                    headers: {
                        'Authorization': authToken
                    },
                    agent: createAgent()
                });
                
                if (!statusResponse.ok) {
                    const responseTime = Date.now() - startTime;
                    updateStats(false, responseTime, `Status check failed: ${statusResponse.status}`);
                    return { success: false, responseTime, error: `Status check failed: ${statusResponse.status}` };
                }
                
                const statusData = await statusResponse.json();
                
                if (statusData.status === 'completed') {
                    const responseTime = Date.now() - startTime;
                    updateStats(true, responseTime);
                    return { success: true, responseTime, data: statusData };
                }
                
                if (statusData.status === 'failed') {
                    const responseTime = Date.now() - startTime;
                    const errorMsg = statusData.error?.message || 'Job failed';
                    updateStats(false, responseTime, errorMsg);
                    return { success: false, responseTime, error: errorMsg };
                }
            }
            
            // Timeout
            const responseTime = Date.now() - startTime;
            updateStats(false, responseTime, 'Job polling timeout');
            return { success: false, responseTime, error: 'Job polling timeout' };
        } else {
            const responseTime = Date.now() - startTime;
            const errorMsg = data.error || data.message || 'Unexpected response';
            updateStats(false, responseTime, errorMsg);
            return { success: false, responseTime, error: errorMsg };
        }
    } catch (error) {
        const responseTime = Date.now() - startTime;
        updateStats(false, responseTime, error.message);
        return { success: false, responseTime, error: error.message };
    }
}

// Make a single request
async function makeRequest(userIndex, requestIndex) {
    const userId = generateUserId(userIndex);
    const sessionId = generateSessionId(userIndex, requestIndex);
    const query = generateQuery(requestIndex);
    const queryType = requestIndex % 2 === 0 ? 'DATA' : 'SERVICE';
    
    try {
        const response = await fetch(`${API_URL}/copilot-agent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authToken
            },
            body: JSON.stringify({
                query: query,
                model: MODEL,
                user_id: userId,
                session_id: sessionId,
                save_chat: false,
                include_history: false,
                stream: USE_STREAMING
            }),
            agent: createAgent()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            updateStats(false, 0, `HTTP ${response.status}: ${errorText}`);
            return { 
                success: false, 
                userIndex, 
                requestIndex, 
                queryType,
                error: `HTTP ${response.status}: ${errorText}` 
            };
        }
        
        if (USE_STREAMING) {
            const result = await handleStreamingResponse(response, userIndex, requestIndex);
            return { ...result, userIndex, requestIndex, queryType };
        } else {
            const result = await handleNonStreamingResponse(response, userIndex, requestIndex);
            return { ...result, userIndex, requestIndex, queryType };
        }
        
    } catch (error) {
        updateStats(false, 0, error.message);
        return { 
            success: false, 
            userIndex, 
            requestIndex, 
            queryType,
            error: error.message 
        };
    }
}

// Update statistics
function updateStats(success, responseTime, error = null) {
    stats.totalRequests++;
    if (success) {
        stats.successfulRequests++;
    } else {
        stats.failedRequests++;
        if (error) {
            stats.errors.push(error);
        }
    }
    
    if (responseTime > 0) {
        stats.totalResponseTime += responseTime;
        stats.minResponseTime = Math.min(stats.minResponseTime, responseTime);
        stats.maxResponseTime = Math.max(stats.maxResponseTime, responseTime);
    }
}

// Run requests for a single user
async function runUserRequests(userIndex) {
    const userResults = [];
    
    for (let i = 0; i < REQUESTS_PER_USER; i++) {
        const result = await makeRequest(userIndex, i);
        userResults.push(result);
        
        // Small delay between requests from same user
        if (i < REQUESTS_PER_USER - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    return userResults;
}

// Main test function
async function runConcurrencyTest() {
    console.log('='.repeat(80));
    console.log('BV-BRC Copilot API - Concurrency Test');
    console.log('='.repeat(80));
    console.log(`API URL: ${API_URL}`);
    console.log(`Model: ${MODEL}`);
    console.log(`Concurrent Users: ${CONCURRENT_USERS}`);
    console.log(`Requests per User: ${REQUESTS_PER_USER}`);
    console.log(`Total Requests: ${CONCURRENT_USERS * REQUESTS_PER_USER}`);
    console.log(`Streaming: ${USE_STREAMING ? 'Yes' : 'No'}`);
    console.log(`Genome IDs available: ${GENOME_IDS.length}`);
    console.log(`Services available: ${SERVICES.length}`);
    console.log('='.repeat(80));
    console.log('\nStarting concurrent requests...\n');
    
    stats.startTime = Date.now();
    
    // Create all user request promises
    const userPromises = [];
    for (let i = 0; i < CONCURRENT_USERS; i++) {
        userPromises.push(runUserRequests(i));
    }
    
    // Wait for all users to complete
    const allResults = await Promise.all(userPromises);
    
    stats.endTime = Date.now();
    
    // Flatten results
    const results = allResults.flat();
    
    // Print results
    console.log('\n' + '='.repeat(80));
    console.log('TEST RESULTS');
    console.log('='.repeat(80));
    
    // Group by user
    const resultsByUser = {};
    results.forEach(result => {
        if (!resultsByUser[result.userIndex]) {
            resultsByUser[result.userIndex] = [];
        }
        resultsByUser[result.userIndex].push(result);
    });
    
    // Print summary by user
    Object.keys(resultsByUser).sort((a, b) => parseInt(a) - parseInt(b)).forEach(userIndex => {
        const userResults = resultsByUser[userIndex];
        const successCount = userResults.filter(r => r.success).length;
        const avgTime = userResults
            .filter(r => r.responseTime)
            .reduce((sum, r) => sum + r.responseTime, 0) / userResults.length;
        
        console.log(`\nUser ${userIndex}:`);
        console.log(`  Success: ${successCount}/${userResults.length}`);
        console.log(`  Avg Response Time: ${avgTime ? avgTime.toFixed(0) : 'N/A'}ms`);
        
        // Show failures
        const failures = userResults.filter(r => !r.success);
        if (failures.length > 0) {
            console.log(`  Failures:`);
            failures.forEach(f => {
                console.log(`    Request ${f.requestIndex} (${f.queryType}): ${f.error || 'Unknown error'}`);
            });
        }
    });
    
    // Overall statistics
    console.log('\n' + '='.repeat(80));
    console.log('OVERALL STATISTICS');
    console.log('='.repeat(80));
    console.log(`Total Requests: ${stats.totalRequests}`);
    console.log(`Successful: ${stats.successfulRequests} (${((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1)}%)`);
    console.log(`Failed: ${stats.failedRequests} (${((stats.failedRequests / stats.totalRequests) * 100).toFixed(1)}%)`);
    
    if (stats.successfulRequests > 0) {
        const avgResponseTime = stats.totalResponseTime / stats.successfulRequests;
        console.log(`\nResponse Times (successful requests only):`);
        console.log(`  Average: ${avgResponseTime.toFixed(0)}ms (${(avgResponseTime / 1000).toFixed(2)}s)`);
        console.log(`  Minimum: ${stats.minResponseTime.toFixed(0)}ms (${(stats.minResponseTime / 1000).toFixed(2)}s)`);
        console.log(`  Maximum: ${stats.maxResponseTime.toFixed(0)}ms (${(stats.maxResponseTime / 1000).toFixed(2)}s)`);
    }
    
    const totalTime = stats.endTime - stats.startTime;
    console.log(`\nTotal Test Duration: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`Requests per Second: ${(stats.totalRequests / (totalTime / 1000)).toFixed(2)}`);
    
    // Error summary
    if (stats.errors.length > 0) {
        console.log(`\nError Summary (showing unique errors):`);
        const errorCounts = {};
        stats.errors.forEach(err => {
            const errKey = err.substring(0, 100); // Truncate long errors
            errorCounts[errKey] = (errorCounts[errKey] || 0) + 1;
        });
        
        Object.entries(errorCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10) // Top 10 errors
            .forEach(([err, count]) => {
                console.log(`  [${count}x] ${err}`);
            });
    }
    
    console.log('='.repeat(80));
    
    // Exit code based on results
    if (stats.failedRequests === 0) {
        console.log('\n✅ All requests succeeded!\n');
        process.exit(0);
    } else {
        console.log(`\n⚠️  ${stats.failedRequests} request(s) failed\n`);
        process.exit(1);
    }
}

// Run the test
runConcurrencyTest().catch(error => {
    console.error('\n✗ Fatal error:', error);
    process.exit(1);
});

