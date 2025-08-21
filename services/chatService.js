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

module.exports = {
  // Core chat flows
  handleCopilotRequest,
  handleCopilotStreamRequest,
  setupCopilotStream,
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
  getPathState
};

