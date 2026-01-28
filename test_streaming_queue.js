// test_streaming_queue.js - Test streaming from queue with real credentials

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
    process.exit(1);
}

const API_URL = 'http://localhost:7032/copilot-api/chatbrc';
const USER_ID = 'clark.cucinell@patricbrc.org';

async function testStreamingQuery(testName, query) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Test: ${testName}`);
    console.log(`Query: "${query}"`);
    console.log('='.repeat(70));
    
    try {
        const response = await fetch(`${API_URL}/copilot-agent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authToken
            },
            body: JSON.stringify({
                query: query,
                model: 'RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16',
                user_id: USER_ID,
                session_id: `test-stream-${testName.replace(/\s+/g, '-')}-${Date.now()}`,
                save_chat: false,
                include_history: false,
                stream: true
            }),
            agent: createAgent() // Use fresh agent to avoid connection pooling issues
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        console.log('\n✓ SSE stream opened\n');
        
        let buffer = '';
        const startTime = Date.now();
        let lastEventTime = startTime;
        let contentBuffer = [];
        
        for await (const chunk of response.body) {
            buffer += chunk.toString();
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (!line.trim()) continue;
                
                // Handle heartbeat comments
                if (line.startsWith(':')) {
                    const now = Date.now();
                    const elapsed = ((now - startTime) / 1000).toFixed(1);
                    console.log(`[${elapsed}s] Heartbeat received`);
                    continue;
                }
                
                const eventMatch = line.match(/event: (\w+)/);
                const dataMatch = line.match(/data: (.+)/);
                
                if (eventMatch && dataMatch) {
                    const eventType = eventMatch[1];
                    const data = JSON.parse(dataMatch[1]);
                    const now = Date.now();
                    const elapsed = ((now - startTime) / 1000).toFixed(1);
                    const sinceLastEvent = ((now - lastEventTime) / 1000).toFixed(1);
                    lastEventTime = now;
                    
                    switch (eventType) {
                        case 'queued':
                            console.log(`[${elapsed}s] 🟡 QUEUED (job_id: ${data.job_id})`);
                            break;
                            
                        case 'started':
                            console.log(`[${elapsed}s] 🟢 STARTED (after ${sinceLastEvent}s wait)`);
                            break;
                            
                        case 'progress':
                            const tool = data.tool || 'planning';
                            console.log(`[${elapsed}s] 🔄 PROGRESS: Iteration ${data.iteration}/${data.max_iterations} - ${tool} (${data.percentage}%)`);
                            break;
                            
                        case 'content':
                            const content = data.delta || data.text || '';
                            contentBuffer.push(content);
                            if (contentBuffer.length === 1) {
                                console.log(`[${elapsed}s] 📝 CONTENT streaming started...`);
                            }
                            // Silently collect content
                            break;
                            
                        case 'final_response':
                            const chunk = data.chunk || '';
                            contentBuffer.push(chunk);
                            // Silently collect chunks
                            break;
                            
                        case 'tool_selected':
                            console.log(`[${elapsed}s] 🔧 Tool selected: ${data.tool}`);
                            break;
                            
                        case 'tool_executed':
                            console.log(`[${elapsed}s] ✓ Tool executed: ${data.tool} (${data.status})`);
                            break;
                            
                        case 'done':
                            const finalContent = contentBuffer.join('');
                            if (finalContent) {
                                console.log(`\n[${elapsed}s] 📄 Final Response:`);
                                console.log('─'.repeat(70));
                                console.log(finalContent);
                                console.log('─'.repeat(70));
                            }
                            console.log(`\n[${elapsed}s] ✅ DONE`);
                            console.log(`  - Iterations: ${data.iterations || 0}`);
                            const toolsUsed = Array.isArray(data.tools_used) ? data.tools_used.join(', ') : 'none';
                            console.log(`  - Tools used: ${toolsUsed}`);
                            console.log(`  - Duration: ${data.duration_seconds}s`);
                            console.log(`  - Session: ${data.session_id}`);
                            console.log(`  - Response length: ${finalContent.length} chars`);
                            return { success: true, elapsed, contentLength: finalContent.length };
                            
                        case 'error':
                            console.log(`\n[${elapsed}s] ❌ ERROR: ${data.error}`);
                            if (data.will_retry) {
                                console.log(`  - Will retry (attempt ${data.retry_attempt})`);
                            }
                            return { success: false, elapsed, error: data.error };
                            
                        default:
                            // Silently ignore other events
                            break;
                    }
                }
            }
        }
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n⚠️  Stream ended without done/error event (${totalTime}s)`);
        return { success: false, elapsed: totalTime, error: 'Unexpected stream end' };
        
    } catch (error) {
        console.error(`\n✗ Test failed:`, error.message);
        return { success: false, error: error.message };
    }
}

async function runTests() {
    console.log('='.repeat(70));
    console.log('BV-BRC Copilot - Streaming Queue Test');
    console.log('='.repeat(70));
    console.log(`User: ${USER_ID}`);
    console.log(`API: ${API_URL}`);
    console.log('='.repeat(70));
    
    const tests = [
        { name: 'Simple greeting', query: 'hello' },
        { name: 'Knowledge query', query: 'How does the Genome Annotation service work' },
        { name: 'Data retrieval', query: 'Can you get me genome data for genome 208964.12' }
    ];
    
    const results = [];
    
    for (const test of tests) {
        const result = await testStreamingQuery(test.name, test.query);
        results.push({ ...test, ...result });
        
        // Wait 2 seconds between tests
        if (tests.indexOf(test) < tests.length - 1) {
            console.log('\n⏳ Waiting 2 seconds before next test...\n');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    
    for (const result of results) {
        const status = result.success ? '✅' : '❌';
        const time = result.elapsed || 'N/A';
        console.log(`${status} ${result.name}: ${time}s`);
        if (result.contentLength) {
            console.log(`   Content length: ${result.contentLength} chars`);
        }
        if (result.error) {
            console.log(`   Error: ${result.error}`);
        }
    }
    
    console.log('='.repeat(70));
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\nPassed: ${successCount}/${results.length}`);
    
    if (successCount === results.length) {
        console.log('\n🎉 All tests passed!\n');
        process.exit(0);
    } else {
        console.log('\n⚠️  Some tests failed\n');
        process.exit(1);
    }
}

// Run tests
runTests();

