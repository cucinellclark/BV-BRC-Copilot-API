# MCP (Model Context Protocol) Integration

This module provides MCP client functionality for the BV-BRC Copilot API, enabling integration with external MCP servers and tools.

## Architecture

The MCP integration follows a modular architecture:

```
services/mcp/
├── config.json              # MCP server configuration
├── mcpClient.js             # Main MCP client manager (singleton)
├── serverManager.js         # Individual server connection management
├── toolRegistry.js          # Tool registration and management
└── utils/
    ├── connectionUtils.js   # HTTP connection utilities
    └── errorHandling.js     # MCP-specific error handling
```

## Configuration

The `config.json` file defines MCP servers and global settings:

```json
{
  "servers": {
    "data_server": {
      "name": "BV-BRC Data Server",
      "url": "http://0.0.0.0:8059",
      "type": "mcp",
      "auth": null,
      "timeout": 30000,
      "description": "Provides access to BV-BRC data services and queries"
    }
  },
  "global_settings": {
    "connection_retry_attempts": 3,
    "connection_retry_delay": 5000,
    "tool_execution_timeout": 60000,
    "enable_tool_streaming": true
  }
}
```

## Key Components

### MCPClient (Singleton)
- Manages connections to multiple MCP servers
- Provides tool execution capabilities
- Handles tool call extraction from LLM responses
- Integrates with the streaming chat system

### ServerManager
- Manages individual server connections
- Handles health checks and reconnection logic
- Executes tools on specific servers
- Supports both regular and streaming tool execution

### ToolRegistry
- Registers and indexes tools from all connected servers
- Provides tool lookup and discovery functionality
- Maintains tool metadata and descriptions

## Integration Points

### Context Builder
The MCP tools are automatically included in the system prompt and context:

```javascript
// MCP tools context is added to system prompts
const mcpToolsContext = mcpClient.getMCPToolsContext();
const availableTools = mcpClient.getAvailableTools();
```

### Tool Execution
The system automatically detects and executes MCP tool calls:

```javascript
// Tool calls are extracted from LLM responses
const toolCalls = mcpClient.extractToolCalls(text);

// Tools are executed with standard HTTP requests (non-streaming)
for (const toolCall of toolCalls) {
  const result = await mcpClient.executeTool(
    toolCall.serverName, 
    toolCall.toolName, 
    toolCall.parameters
  );
}
```

## Tool Call Format

The system expects LLM responses to contain tool calls in this format:

```
[TOOL:serverName:toolName:{"param1":"value1","param2":"value2"}]
```

Example:
```
[TOOL:data_server:search_genomes:{"query":"E. coli","limit":10}]
```

## API Endpoints

### MCP Management
- `GET /copilot-api/chatbrc/mcp/status` - Get MCP status and connected servers
- `GET /copilot-api/chatbrc/mcp/tools` - List available tools (optionally by server)
- `POST /copilot-api/chatbrc/mcp/execute` - Execute a specific tool

### Streaming Integration
- `POST /copilot-api/chatbrc/copilot-stream` - Enhanced with MCP tool execution

## Streaming Events

The streaming system now supports additional event types:

- `tool_start` - Tool execution started
- `tool_result` - Tool execution completed with result
- `tool_error` - Tool execution failed

## Error Handling

The system includes comprehensive error handling:

- `MCPError` - Base error class
- `MCPConnectionError` - Server connection issues
- `MCPToolExecutionError` - Tool execution failures

## Testing

Run the test script to verify MCP integration:

```bash
node test-mcp.js
```

## Adding New MCP Servers

1. Add server configuration to `config.json`
2. Ensure the server implements the MCP protocol endpoints:
   - `GET /health` - Health check
   - `GET /mcp/capabilities` - Server capabilities
   - `GET /mcp/tools` - Available tools
   - `POST /mcp/execute` - Tool execution

## Usage in Chat

When MCP tools are available, the LLM will automatically receive information about them in the system prompt. Users can ask questions that will trigger tool usage, and the system will:

1. Detect tool calls in the LLM response
2. Execute the tools on the appropriate servers using standard HTTP requests
3. Include tool results in the final response

## Extensibility

The architecture is designed to be easily extensible:

- Add new servers by updating the configuration
- Implement custom tool execution logic
- Extend error handling for specific use cases

## Dependencies

- `axios` - HTTP client for server communication
- Built-in Node.js modules for error handling
