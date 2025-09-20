// services/chatService.js

// Import from the new modular structure
const {
  handleCopilotRequest,
  handleChatRequest,
  handleRagRequest,
  handleChatImageRequest,
  handleLambdaDemo,
  handleChatQuery
} = require('./chat/core/chatHandlers');

const {
  setupCopilotStream,
  handleCopilotStreamRequest,
  startCopilotSse
} = require('./chat/streaming/streamingHandlers');

const {
  getOpenaiClient,
  queryModel,
  queryRequest,
  runModel,
  runModelStream,
  getPathState
} = require('./queries/modelQueries');

const {
  createMessage,
  createQueryFromMessages
} = require('./chat/utils/messageUtils');

const {
  enhanceQuery
} = require('./chat/utils/queryEnhancement');

const mcpClient = require('./mcp/mcpClient');

module.exports = {
  // Core chat flows
  handleCopilotRequest,
  handleCopilotStreamRequest,
  setupCopilotStream,
  startCopilotSse,
  handleChatRequest,
  handleRagRequest,
  handleChatImageRequest,
  handleLambdaDemo,

  // Additional chat utilities
  handleChatQuery,
  createQueryFromMessages,
  enhanceQuery,

  // Infrastructure helpers
  getOpenaiClient,
  queryModel,
  queryRequest,
  runModel,
  runModelStream,
  getPathState,

  // MCP functionality
  mcpClient,
  getAvailableMCPTools: () => mcpClient.getAvailableTools(),
  getMCPToolsByServer: (serverName) => mcpClient.getToolsByServer(serverName),
  executeMCPTool: (serverName, toolName, params) => mcpClient.executeTool(serverName, toolName, params),
  getMCPToolsForPrompt: () => mcpClient.getToolsForPrompt(),
  getConnectedMCPServers: () => mcpClient.getConnectedServers(),
  initializeMCP: () => mcpClient.initialize()
};

