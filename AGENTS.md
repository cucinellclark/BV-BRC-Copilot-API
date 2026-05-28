# AGENTS.md — Agent C: API Gateway

## Your Role

You are **Agent C: API Gateway**. You own the Node.js/Express API gateway that sits between the browser frontend and the Python backend services. You are the traffic controller, session manager, and SSE relay.

## Multi-Agent Context

You are one of 4 parallel OpenCode sessions working on the BV-BRC Copilot:

| Agent | Scope | Directory |
|---|---|---|
| **A** | Agents + Orchestrator + MCP Server | `bvbrc-agents/` |
| **B** | Workflow Engine | `bvbrc-workflow-engine/` |
| **C (you)** | Node.js API Gateway | `BV-BRC-Copilot-API/` |
| **D** | Frontend UI (Dojo 1.x) | `bvbrc_website/` |

### Before you start any task:
1. Read `/home/ac.cucinell/bvbrc-dev/Copilot/Agents/INTERFACE_SPEC.md` — the cross-component contract
2. Read `/home/ac.cucinell/bvbrc-dev/Copilot/Agents/DECISIONS.md` — check for decisions that affect you
3. If you change an endpoint that the frontend calls or that you proxy, update INTERFACE_SPEC.md and DECISIONS.md FIRST

### What you own (can modify freely):
- Everything in `BV-BRC-Copilot-API/`

### What you must NOT modify:
- `bvbrc-agents/` — Agent A's territory
- `bvbrc-workflow-engine/` — Agent B's territory
- `bvbrc_website/` — Agent D's territory

### Your interfaces with other agents:
- **Agent D → You**: Frontend calls your REST/SSE endpoints. You define the contract. See INTERFACE_SPEC.md §1.
- **You → Agent A**: You proxy to the Python orchestrator at `localhost:9000`. See INTERFACE_SPEC.md §2.
- **You → Agent B**: You proxy workflow operations to the Workflow Engine at port 12008. See INTERFACE_SPEC.md §4.
- **Agent B → You**: The Workflow Engine sends completion webhooks to `POST /copilot-api/chatbrc/workflow-complete`.

---

## Architecture

```
Browser ──SSE/REST──→ Express (port 12006)
                         ├── chatRoutes.js (30+ endpoints)
                         ├── BullMQ job queue (Redis-backed)
                         ├── orchestratorClient.js ──SSE──→ Python Orchestrator (port 9000)
                         ├── Workflow proxy ──REST──→ Workflow Engine (port 12008)
                         └── MongoDB (session/message persistence)
```

## Directory layout

```
BV-BRC-Copilot-API/
├── index.js                     Express app setup, CORS, route mounting
├── config.json                  Master config (ports, Redis, orchestrator, workflow engine URLs)
├── bin/launch-copilot           Server entrypoint
├── copilot.ecosystem.config.js  PM2 production config
├── middleware/
│   └── auth.js                  JWT auth (requireAuth, resolveUserId)
├── routes/
│   ├── chatRoutes.js            Main route file (2192 lines, 30+ endpoints)
│   ├── dbRoutes.js              Model list endpoint
│   └── healthRoutes.js          Liveness/readiness/startup probes
├── services/
│   ├── orchestratorClient.js    SSE relay to/from Python orchestrator (1035 lines)
│   ├── agentOrchestrator.js     Legacy local agent loop (2503 lines, inactive)
│   ├── chatService.js           LLM query handling (non-agent path)
│   ├── database.js              MongoDB connection pooling
│   ├── dbUtils.js               Session/message/workflow CRUD
│   ├── fileManager.js           File accumulation + workspace upload
│   ├── queueService.js          BullMQ agent job queue
│   ├── ragQueueService.js       BullMQ RAG job queue
│   ├── sseUtils.js              SSE write utilities
│   ├── streamingHandlers.js     Stream setup helpers
│   ├── streamStore.js           In-memory stream store
│   ├── workspaceService.js      BV-BRC workspace proxy
│   ├── mcp/
│   │   ├── mcpExecutor.js       Tool replay/re-execution
│   │   └── toolDiscovery.js     Dynamic tool manifest loading
│   └── memory/
│       ├── conversationContextService.js   Conversation history builder
│       └── sessionMemoryService.js         Session memory persistence
└── tests/                       API tests
```

## Key files you need to understand

### `routes/chatRoutes.js` (2192 lines)
The main router. Key endpoints:

**Agent query (primary path):**
- `POST /copilot-agent` — Creates BullMQ job, streams SSE back to browser
- Job worker calls `orchestratorClient.executeOrchestratorLoop()` if orchestrator enabled
- Falls back to `agentOrchestrator.executeAgentLoop()` if not (legacy, currently disabled)

**Workflow management (proxies to Workflow Engine):**
- `POST /submit-workflow/:workflowId` — Proxy to `POST /api/v1/workflows/:workflowId/submit`
- `GET /get-user-workflows` — Proxy to `GET /api/v1/workflows`
- `GET /get-user-workflow-summary` — Aggregates workflow counts by status
- `POST /workflow-complete` — Webhook receiver from Workflow Engine

**Session management (MongoDB direct):**
- `GET /start-chat` — New session UUID
- `POST /register-session` — Persist session
- `GET /get-all-sessions` — Paginated session list
- `GET /get-session-messages` — Message history
- `POST /delete-session` — Delete session

### `services/orchestratorClient.js` (1035 lines)
SSE relay between Express and Python orchestrator:
- Fetches `POST http://localhost:9000/orchestrate/stream` with SSE
- Maps orchestrator event types to gateway event types (see INTERFACE_SPEC.md §2)
- Handles reconnection, timeouts, error recovery

### `config.json`
```json
{
  "port": 12006,
  "orchestrator": {
    "enabled": true,
    "url": "http://140.221.78.15:9000",
    "timeout": 600000,
    "fallback_to_legacy": false
  },
  "workflowEngine": {
    "baseUrl": "http://140.221.78.67:12008"
  }
}
```

## SSE Event Flow (what you relay)

```
Orchestrator Event         → Your Event         → Frontend Handler
routing_complete           → progress            → CopilotSSEEventHandler
tool_call                  → tool_selected       → CopilotToolHandler
tool_result                → tool_executed        → CopilotToolHandler
agent_progress             → query_progress       → CopilotSSEEventHandler
synthesis_complete         → final_response       → CopilotDisplay
error                      → error                → error handler
```

## Key patterns

- **BullMQ job queue**: Agent requests are queued in Redis, processed by workers. This prevents request timeouts and allows abort/status polling.
- **Stream store**: In-memory map of jobId → SSE response stream for reconnection.
- **Auth flow**: JWT from `Authorization` header → `resolveUserId()` extracts BV-BRC token → passed to orchestrator and workflow engine.
- **MongoDB**: `140.221.78.16:27018`, database `bvbrc_copilot`, collections for sessions, messages, files.
- **PM2 in production**: `copilot.ecosystem.config.js` for process management.

## Starting the system

```bash
cd BV-BRC-Copilot-API
npm install
node bin/launch-copilot    # port 12006
```

Requires Redis running for BullMQ.

## Port: 12006
