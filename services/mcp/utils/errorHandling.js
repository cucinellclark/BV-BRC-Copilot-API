// services/mcp/utils/errorHandling.js

class MCPError extends Error {
  constructor(message, serverName = null, toolName = null, originalError = null) {
    super(message);
    this.name = 'MCPError';
    this.serverName = serverName;
    this.toolName = toolName;
    this.originalError = originalError;
    this.timestamp = new Date();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      serverName: this.serverName,
      toolName: this.toolName,
      timestamp: this.timestamp,
      originalError: this.originalError?.message || null
    };
  }
}

class MCPConnectionError extends MCPError {
  constructor(message, serverName, originalError = null) {
    super(`Connection error: ${message}`, serverName, null, originalError);
    this.name = 'MCPConnectionError';
  }
}

class MCPToolExecutionError extends MCPError {
  constructor(message, serverName, toolName, originalError = null) {
    super(`Tool execution error: ${message}`, serverName, toolName, originalError);
    this.name = 'MCPToolExecutionError';
  }
}

function handleMCPError(error, context = {}) {
  console.error('MCP Error:', {
    error: error.message,
    context,
    stack: error.stack,
    timestamp: new Date()
  });

  if (error instanceof MCPError) {
    return error;
  }

  return new MCPError(
    error.message || 'Unknown MCP error',
    context.serverName || null,
    context.toolName || null,
    error
  );
}

module.exports = {
  MCPError,
  MCPConnectionError,
  MCPToolExecutionError,
  handleMCPError
};
