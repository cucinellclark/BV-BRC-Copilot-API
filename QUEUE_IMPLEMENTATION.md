# Queue Implementation Documentation

**Date**: January 28, 2026  
**Status**: ✅ Implemented and Tested

## Overview

The BV-BRC Copilot API now uses Bull queue with Redis backend for the `/copilot-agent` endpoint. This enables safe scaling, backpressure management, and better resource control.

## Architecture

```
┌──────────────┐
│   Client     │
└──────┬───────┘
       │ POST /copilot-agent
       ▼
┌──────────────────┐
│  Express Route   │──────► Returns 202 with job_id
└──────┬───────────┘
       │ addAgentJob()
       ▼
┌──────────────────┐     ┌─────────────┐
│   Bull Queue     │────▶│   Redis     │
│ (agent-operations)│     │  (Storage)  │
└──────┬───────────┘     └─────────────┘
       │ process (3 workers)
       ▼
┌──────────────────┐
│  AgentOrchestrator│──────► Saves to MongoDB
└──────────────────┘
       │
       ▼
┌──────────────────┐
│  Client Polls    │
│  GET /job/:id    │
└──────────────────┘
```

## Files Created/Modified

### New Files
- `services/queueService.js` - Bull queue service with job processing
- `test_queue.js` - Integration test script

### Modified Files
- `routes/chatRoutes.js` - Updated `/copilot-agent` to queue jobs, added job status endpoints

## Configuration

Queue settings are in `config.json`:

```json
{
  "redis": {
    "host": "127.0.0.1",
    "port": 6379,
    "jobResultTTL": 3600
  },
  "queue": {
    "workerConcurrency": 3,
    "maxJobsPerWorker": 5,
    "jobTimeout": 600000,
    "maxRetries": 3
  },
  "agent": {
    "max_iterations": 8,
    "job_poll_interval": 1000,
    "job_max_wait": 600000
  }
}
```

**Settings Explained**:
- `workerConcurrency: 3` - 3 workers per PM2 instance (9 total with 3 PM2 instances)
- `jobTimeout: 600000` - 10-minute timeout per job
- `maxRetries: 3` - Jobs retry up to 3 times with exponential backoff
- `job_poll_interval: 1000` - Client should poll every 1 second
- `jobResultTTL: 3600` - Keep completed jobs for 1 hour

## API Endpoints

### 1. Submit Agent Job (Queued)

**Endpoint**: `POST /copilot-api/chatbrc/copilot-agent`

**Request**:
```json
{
  "query": "Search for genomes in genus Salmonella",
  "model": "model-name",
  "user_id": "user@example.com",
  "session_id": "session-uuid",
  "system_prompt": "optional",
  "save_chat": true,
  "include_history": true,
  "auth_token": "optional-brc-auth-token"
}
```

**Response** (202 Accepted):
```json
{
  "message": "Agent job queued successfully",
  "job_id": "1",
  "session_id": "session-uuid",
  "status_endpoint": "/copilot-api/chatbrc/job/1/status",
  "poll_interval_ms": 1000
}
```

### 2. Check Job Status

**Endpoint**: `GET /copilot-api/chatbrc/job/:jobId/status`

**Response**:
```json
{
  "found": true,
  "jobId": "1",
  "status": "active",
  "progress": {
    "currentIteration": 3,
    "maxIterations": 8,
    "currentTool": "genome_list",
    "percentage": 45
  },
  "error": null,
  "timestamps": {
    "created": 1769627975335,
    "started": "2026-01-28T19:19:35.342Z",
    "updated": "2026-01-28T19:20:15.123Z",
    "processed": 1769627975400,
    "finished": null
  },
  "attempts": {
    "made": 1,
    "remaining": 2
  },
  "data": {
    "session_id": "session-uuid",
    "user_id": "user@example.com"
  }
}
```

**Job Status Values**:
- `waiting` - Job is queued, waiting for a worker
- `active` - Job is currently being processed
- `completed` - Job finished successfully (check session messages in DB)
- `failed` - Job failed after all retries (check `error` field)
- `delayed` - Job is waiting to retry after a failure

**Note**: This endpoint does NOT return the final result. When `status: "completed"`, the client should fetch the conversation messages using `GET /get-session-messages?session_id={session_id}`.

### 3. Queue Statistics (Monitoring)

**Endpoint**: `GET /copilot-api/chatbrc/queue/stats`

**Response**:
```json
{
  "message": "Queue statistics",
  "timestamp": "2026-01-28T19:19:35.000Z",
  "stats": {
    "waiting": 5,
    "active": 3,
    "completed": 120,
    "failed": 2,
    "delayed": 1,
    "total": 131
  }
}
```

## Client Usage Pattern

```javascript
// 1. Submit job
const submitResponse = await fetch('/copilot-api/chatbrc/copilot-agent', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    query: 'Search for genomes in genus Salmonella',
    model: 'model-name',
    user_id: 'user@example.com',
    session_id: 'session-uuid'
  })
});

const { job_id, poll_interval_ms } = await submitResponse.json();

// 2. Poll for status
const pollStatus = async () => {
  const statusResponse = await fetch(`/copilot-api/chatbrc/job/${job_id}/status`, {
    headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
  });
  
  const status = await statusResponse.json();
  
  if (status.status === 'completed') {
    // Job finished - fetch results from session
    const messagesResponse = await fetch(
      `/copilot-api/chatbrc/get-session-messages?session_id=${status.data.session_id}`,
      { headers: { 'Authorization': 'Bearer YOUR_TOKEN' } }
    );
    const { messages } = await messagesResponse.json();
    console.log('Final result:', messages[messages.length - 1]);
    return;
  }
  
  if (status.status === 'failed') {
    console.error('Job failed:', status.error);
    return;
  }
  
  // Still processing - update UI with progress
  console.log(`Progress: ${status.progress.percentage}% - Iteration ${status.progress.currentIteration}/${status.progress.maxIterations}`);
  
  // Poll again after interval
  setTimeout(pollStatus, poll_interval_ms);
};

// Start polling
pollStatus();
```

## Worker Capacity

With current configuration:
- **3 PM2 instances** × **3 workers per instance** = **9 concurrent agent operations**
- Additional requests queue up in Redis (no memory pressure on Node.js)
- Workers automatically pick up jobs from the queue

## Monitoring

### Queue Health Checks

```bash
# Check queue stats
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:7032/copilot-api/chatbrc/queue/stats

# Check specific job
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:7032/copilot-api/chatbrc/job/1/status
```

### Redis Queue Inspection

```bash
# Count jobs by status
redis-cli LLEN "bull:agent-operations:wait"      # Waiting jobs
redis-cli LLEN "bull:agent-operations:active"    # Active jobs
redis-cli LLEN "bull:agent-operations:completed" # Completed jobs
redis-cli LLEN "bull:agent-operations:failed"    # Failed jobs
```

## Testing

Run the integration test:

```bash
node test_queue.js
```

Expected output:
- ✓ Queue stats retrieved successfully
- ✓ Job added to queue successfully
- ✓ Job status retrieved successfully
- ✓ Queue now has jobs
- ✓ Job status tracking working
- ✓ Correctly handles non-existent jobs

## Benefits Achieved

1. **Backpressure Management**: Requests queue instead of overwhelming the system
2. **Fair Scheduling**: FIFO processing with optional priorities
3. **Retry Logic**: Automatic retry with exponential backoff
4. **Visibility**: Track job progress and status
5. **Resilience**: Jobs survive server restarts (persisted in Redis)
6. **Scalability**: Can easily add more workers or PM2 instances

## Known Limitations

1. **No Streaming**: Queued jobs use non-streaming execution (results saved to DB)
2. **Polling Required**: Client must poll for completion (no webhooks yet)
3. **Single Endpoint**: Only `/copilot-agent` is queued (other endpoints still synchronous)

## Future Enhancements

- [ ] Add priority levels (high/normal/low)
- [ ] Implement webhook callbacks on job completion
- [ ] Add WebSocket support for real-time progress updates
- [ ] Queue other expensive endpoints (`/rag`, `/rag-distllm`)
- [ ] Add job cancellation endpoint
- [ ] Implement job result caching

## Success Metrics

- ✅ Queue processes jobs without memory leaks
- ✅ Job status tracking accurate
- ✅ Retry logic works (exponential backoff)
- ✅ Graceful shutdown preserves jobs
- ⏳ 1000 jobs processed without issues (pending load test)
- ⏳ Queue survives PM2 restart (pending validation)

## Troubleshooting

### Redis Not Running

```bash
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Solution**: Start Redis server:
```bash
cd ~/redis
./start-redis.sh
```

### Jobs Stuck in "Active" State

Check worker logs:
```bash
pm2 logs copilot-api
```

If workers crashed, restart:
```bash
pm2 restart copilot-api
```

### Too Many Queued Jobs

Increase worker concurrency in `config.json`:
```json
{
  "queue": {
    "workerConcurrency": 5  // Increase from 3 to 5
  }
}
```

Then restart:
```bash
pm2 restart copilot-api
```

