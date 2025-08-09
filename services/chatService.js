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
  handleCopilotStreamRequest
} = require('./chat/streaming/streamingHandlers');

// Import MCP streaming handlers
const {
  setupCopilotMCPStream,
  handleCopilotMCPStreamRequest
} = require('./mcp/mcpStreamingHandlers');

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

// Import MCP services
const { MCPOrchestrator } = require('./mcp/mcpOrchestrator');
const { BVBRCMCPClient } = require('./mcp/mcpClient');

module.exports = {
  // Core chat flows
  handleCopilotRequest,
  handleCopilotStreamRequest,
  setupCopilotStream,
  handleChatRequest,
  handleRagRequest,
  handleChatImageRequest,
  handleLambdaDemo,

  // MCP streaming support
  setupCopilotMCPStream,
  handleCopilotMCPStreamRequest,

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

  // MCP utilities
  getMCPOrchestrator: () => new MCPOrchestrator(),
  getMCPClient: () => new BVBRCMCPClient()
};

