# LlamaIndex Integration - Quick Reference

## Overview

LlamaIndex is being integrated into the BV-BRC Copilot API to provide intelligent chat history management and automatic conversation summarization. This document provides a quick reference for how it fits into the concurrency readiness plan.

---

## Why LlamaIndex?

### Problems It Solves

1. **Long Conversation Context**
   - Current: Load entire conversation history → 10,000-50,000 tokens
   - With LlamaIndex: Load summary → 500-2,000 tokens
   - **Result**: 80-90% token reduction

2. **Memory Growth**
   - Current: Full message arrays in memory for each session
   - With LlamaIndex: Smart memory management with LRU eviction
   - **Result**: Bounded memory usage

3. **API Costs**
   - Current: Send full history to LLM every request
   - With LlamaIndex: Send concise summaries
   - **Result**: 60%+ cost reduction

4. **Response Times**
   - Current: Large contexts = slow LLM processing
   - With LlamaIndex: Smaller contexts = faster responses
   - **Result**: 30-50% faster for long conversations

---

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────┐
│                    Chat Request                          │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 1: ChatMemoryService (Memory Management)         │
│  - LRU pool of 50 memory instances per PM2 instance     │
│  - Load from MongoDB or create new                       │
│  - Smart token budget allocation                         │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Context Retrieval                             │
│  - Get relevant history for current query               │
│  - Use summary if available (fast)                      │
│  - Fall back to recent messages if no summary           │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Background Summarization (Async)              │
│  - Trigger every 20 messages                            │
│  - Process in Bull queue (non-blocking)                 │
│  - Cache in Redis + persist to MongoDB                  │
└─────────────────────────────────────────────────────────┘
```

---

## Concurrency Impact

### Resource Management

**Memory Instances**:
- **Limit**: 50 active LlamaIndex memories per PM2 instance
- **Total**: 3 instances × 50 = 150 memories system-wide
- **Eviction**: LRU policy after 30 minutes idle
- **Memory per instance**: ~5-10MB

**Summarization Queue**:
- **Workers**: 3 concurrent summary workers
- **Priority**: Low (5) - doesn't block chat requests
- **Processing time**: 10-30 seconds per summary
- **Throughput**: ~360 summaries/hour (3 workers × 2 min each)

**Total Resource Impact**:
```
100 Concurrent Users:
├─ LlamaIndex Memory: 100 × 10MB = 1GB
├─ Summary Queue: 3 active jobs at any time
├─ LLM API Calls: ~5 summaries/minute (not 100/minute!)
└─ Cache Storage: ~100 summaries × 2KB = 200KB

Comparison Without LlamaIndex:
├─ Message Arrays: 100 × 50 messages × 1KB = 5GB
├─ Token Processing: 100 requests × 30K tokens
└─ LLM API Costs: 10x higher
```

---

## Integration Points

### Issue #2: Queue Management
**Integration**: Add summarization queue alongside chat queue
```javascript
const chatQueue = new Queue('chat', redisConfig);
const summaryQueue = new Queue('chat-summary', redisConfig);

// Summary jobs are lower priority
summaryQueue.process('summarize', 3, async (job) => {
  // Generate summary in background
});
```

### Issue #3: MongoDB
**Integration**: Add summary fields to session schema
```javascript
{
  sessionId: String,
  userId: String,
  messages: Array,
  summary: String,              // NEW: Generated summary
  summary_updated_at: Date,     // NEW: Last summary time
  summary_message_count: Number // NEW: Messages when summarized
}
```

### Issue #4: Agent Resource Management
**Integration**: Agents use LlamaIndex for history context
```javascript
// Agent planning with intelligent history
const memory = await chatMemoryService.getMemory(session_id, user_id);
const context = await memory.get(query, { tokenLimit: 2000 });

// Planning prompt includes concise context instead of full history
const planningPrompt = buildPlanningPrompt(query, context, toolResults);
```

### Issue #7: Observability
**Integration**: Add LlamaIndex metrics to monitoring
```javascript
// Prometheus metrics
const activeMemories = new Gauge('copilot_llamaindex_active_memories');
const summaryDuration = new Histogram('copilot_summary_generation_duration_seconds');
const summaryCacheHits = new Counter('copilot_summary_cache_hits_total');
```

### Issue #8: Caching
**Integration**: Cache summaries and context results
```javascript
// Summary cache
const cacheKey = `summary:${sessionId}:${messageCount}`;
await cacheService.set(cacheKey, summary, 3600); // 1 hour

// Context cache
const contextKey = `context:${sessionId}:${hash(query)}`;
await cacheService.set(contextKey, context, 600); // 10 minutes
```

---

## Implementation Timeline

### Week 3: Core Memory Service
**Days 1-3**: Memory service implementation
- ✅ Create `ChatMemoryService` class
- ✅ Implement LRU pooling
- ✅ Load/save from MongoDB
- ✅ Integrate with `/chat` route

**Days 4-5**: Testing
- ✅ Test with 50 concurrent sessions
- ✅ Verify LRU eviction
- ✅ Memory leak testing

### Week 4: Summarization Pipeline
**Days 1-3**: Summary worker
- ✅ Create Bull queue for summaries
- ✅ Implement summary generation
- ✅ Add caching layer
- ✅ MongoDB persistence

**Days 4-5**: API & Testing
- ✅ Add summary API endpoint
- ✅ Test summary generation under load
- ✅ Validate cache hit rates

---

## Configuration

### Recommended Settings

```json
{
  "llamaindex": {
    "enabled": true,
    "llm_model": "gpt-4o-mini",  // Cheaper for summaries
    "default_token_limit": 40000,
    "agent_planning_token_limit": 2000,
    "agent_response_token_limit": 8000,
    
    "memory": {
      "max_active_instances": 50,      // Per PM2 instance
      "idle_timeout_ms": 1800000,      // 30 minutes
      "eviction_policy": "lru",
      "token_budget_for_history": 0.3  // 30% of total
    },
    
    "summarization": {
      "enabled": true,
      "trigger_every_n_messages": 20,  // Summarize every 20 messages
      "min_messages_for_summary": 10,  // Don't summarize short convos
      "max_concurrent_workers": 3,
      "queue_priority": 5,             // Lower than chat (1-4)
      "cache_ttl": 3600,               // 1 hour
      "model": "gpt-4o-mini"           // Use cheaper model
    }
  }
}
```

### Tuning Guidelines

**For High Traffic (1000+ users)**:
- Increase `max_active_instances` to 100
- Increase `max_concurrent_workers` to 5
- Reduce `cache_ttl` to 1800 (30 min) to stay fresh

**For Low Traffic (< 100 users)**:
- Decrease `max_active_instances` to 20
- Keep `max_concurrent_workers` at 2
- Increase `cache_ttl` to 7200 (2 hours)

**For Cost Optimization**:
- Increase `trigger_every_n_messages` to 30
- Increase `min_messages_for_summary` to 15
- Use `gpt-3.5-turbo` for summaries (even cheaper)

---

## Monitoring

### Key Metrics

**Memory Management**:
```
copilot_llamaindex_active_memories{instance="0"}
- Target: < 50 per PM2 instance
- Alert if > 45 (near capacity)

copilot_llamaindex_memory_load_duration_seconds
- Target: p95 < 0.5s
- Alert if p95 > 2s
```

**Summarization**:
```
copilot_summary_generation_duration_seconds
- Target: p95 < 30s
- Alert if p95 > 60s

copilot_summary_queue_depth
- Target: < 20
- Alert if > 50 (backlog building)

copilot_summary_cache_hits_total
- Target: > 80% hit rate
- Alert if < 50%
```

### Grafana Dashboard Queries

**Active Memory Instances**:
```promql
sum(copilot_llamaindex_active_memories) by (instance)
```

**Summary Generation Rate**:
```promql
rate(copilot_summaries_generated_total[5m])
```

**Cache Hit Rate**:
```promql
rate(copilot_summary_cache_hits_total[5m]) / 
rate(copilot_summary_requests_total[5m])
```

---

## Failure Modes & Mitigations

### 1. Memory Leak
**Symptom**: `active_memories` grows unbounded
**Mitigation**: 
- LRU eviction enforced at 50 instances
- 30-minute idle timeout
- Periodic cleanup job

### 2. Summarization Backlog
**Symptom**: `summary_queue_depth` > 100
**Mitigation**:
- Increase worker count temporarily
- Disable summarization for low-priority sessions
- Alert team to investigate

### 3. Summary Generation Failures
**Symptom**: High rate of failed summary jobs
**Mitigation**:
- 2 retry attempts with exponential backoff
- Fallback to recent messages if summary fails
- Circuit breaker on LLM API

### 4. Stale Summaries
**Symptom**: Summary doesn't reflect recent messages
**Mitigation**:
- Cache key includes message count (auto-invalidate)
- Force regenerate endpoint available
- Summary timestamp tracked

---

## Cost Analysis

### Expected Costs (1000 Active Users)

**Assumptions**:
- 1000 users
- 10 conversations per user per month
- Average 50 messages per conversation
- Summary generated every 20 messages = 2.5 summaries per conversation

**Calculations**:
```
Without LlamaIndex:
- Conversations: 10,000
- Avg context per request: 30,000 tokens
- Total tokens: 10,000 × 50 messages × 30K = 15B tokens
- Cost @ $0.002/1K tokens: $30,000/month

With LlamaIndex:
- Chat tokens: 10,000 × 50 × 3K (summary) = 1.5B tokens
- Summary generation: 10,000 × 2.5 × 1K = 25M tokens
- Total tokens: 1.525B tokens
- Cost @ $0.002/1K tokens: $3,050/month

Savings: $26,950/month (90% reduction!)
```

**Note**: These are estimates. Actual savings depend on:
- Average conversation length
- Query complexity
- Summary quality requirements

---

## Testing Checklist

### Unit Tests
- [ ] Memory service creates/loads instances correctly
- [ ] LRU eviction works as expected
- [ ] Summary generation produces valid output
- [ ] Token budget allocation correct

### Integration Tests
- [ ] Chat route uses LlamaIndex context
- [ ] Summaries saved to MongoDB
- [ ] Cache hit/miss logic works
- [ ] Queue processes jobs correctly

### Load Tests
- [ ] 100 concurrent sessions with memory
- [ ] 100 simultaneous summary requests
- [ ] 24-hour stability test (no memory leaks)
- [ ] Cache hit rate > 80% under load

### Chaos Tests
- [ ] Redis failure (graceful degradation)
- [ ] MongoDB slow queries (timeout handling)
- [ ] LLM API rate limit (retry logic)
- [ ] Queue worker crash (job recovery)

---

## API Endpoints

### Get Session Summary
```
GET /copilot-api/chatbrc/get-session-summary?session_id={id}

Response (summary exists):
{
  "summary": "User asked about genome search...",
  "messageCount": 45,
  "lastUpdated": "2026-01-28T10:30:00Z"
}

Response (no summary yet):
{
  "message": "Summary generation queued",
  "estimatedTime": "10-30 seconds"
}
```

### Force Regenerate Summary
```
GET /copilot-api/chatbrc/get-session-summary?session_id={id}&force_regenerate=true

Response:
{
  "summary": "Updated summary...",
  "messageCount": 45,
  "regenerated": true
}
```

### Get Memory Stats
```
GET /copilot-api/admin/llamaindex-stats

Response:
{
  "activeMemories": 23,
  "maxActiveMemories": 50,
  "utilizationPercent": 46,
  "oldestAccessAgo": 1234567,
  "summaryQueue": {
    "waiting": 5,
    "active": 2,
    "completed": 1234,
    "failed": 3
  }
}
```

---

## Migration Plan

### Phase 1: Parallel Testing (Week 3)
1. Deploy LlamaIndex code but keep `enabled: false`
2. Run shadow mode: generate summaries but don't use them
3. Compare old vs new context quality
4. Validate no performance regression

### Phase 2: Gradual Rollout (Week 4)
1. Enable for 10% of users
2. Monitor metrics: latency, cache hits, memory usage
3. Increase to 50% if no issues
4. Full rollout to 100%

### Phase 3: Deprecate Old System (Week 5)
1. Keep fallback code for 1 month
2. Remove old history management after validation
3. Clean up deprecated code

---

## Troubleshooting

### Problem: High Memory Usage
**Check**:
```bash
# Check active instances
curl http://localhost:7032/copilot-api/admin/llamaindex-stats

# Expected: < 50 per PM2 instance
```
**Fix**: Reduce `max_active_instances` or `idle_timeout_ms`

### Problem: Slow Summary Generation
**Check**:
```bash
# Check queue depth
curl http://localhost:7032/copilot-api/admin/llamaindex-stats | jq '.summaryQueue'

# Expected: waiting < 20
```
**Fix**: Increase `max_concurrent_workers` or use faster model

### Problem: Low Cache Hit Rate
**Check**:
```bash
# Check cache stats
curl http://localhost:7032/copilot-api/admin/cache/stats

# Expected: hit rate > 80%
```
**Fix**: Increase `cache_ttl` or check Redis memory limits

---

## References

- [LlamaIndex Documentation](https://docs.llamaindex.ai/)
- [LlamaIndex Chat Memory](https://docs.llamaindex.ai/en/stable/module_guides/storing/chat_stores/)
- [Main Concurrency Plan](./CONCURRENCY_READINESS_PLAN.md#issue-11-llamaindex-chat-history--summarization)
- [Bull Queue Documentation](https://github.com/OptimalBits/bull)

---

**Last Updated**: January 28, 2026  
**Version**: 1.0

