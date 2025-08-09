// services/mcp/mcpStreamingHandlers.js

const { v4: uuidv4 } = require('uuid');
const { MCPOrchestrator, MCPOrchestratorError } = require('./mcpOrchestrator');
const { BVBRCMCPClient, MCPError } = require('./mcpClient');
const { ToolSelectorError } = require('./toolSelector');
const { LLMServiceError } = require('../llm/llmServices');
const {
  getModelData,
  createChatSession,
  addMessagesToSession
} = require('../chat/core/dbUtils');
const { prepareCopilotContext } = require('../chat/core/contextBuilder');
const { runModelStream } = require('../queries/modelQueries');
const { createMessage } = require('../chat/utils/messageUtils');
const { sendSseError, startKeepAlive, stopKeepAlive } = require('../chat/streaming/sseUtils');
const streamStore = require('../chat/streaming/streamStore');

async function setupCopilotMCPStream(opts) {
  try {
    const {
      save_chat = true,
      session_id,
      user_id,
      mcp_options = {}
    } = opts;

    // Build context using existing logic
    const {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      chatSession
    } = await prepareCopilotContext(opts);

    // Remove RAG docs to keep payload small
    if (ctx && ctx.ragDocs) delete ctx.ragDocs;

    // Create message and stream IDs
    const assistantMessageId = uuidv4();
    const streamId = uuidv4();

    // Persist initial messages
    if (save_chat) {
      if (!chatSession) await createChatSession(session_id, user_id);
      const initialMsgs = systemMessage ? [userMessage, systemMessage] : [userMessage];
      await addMessagesToSession(session_id, initialMsgs);
    }

    // Complete MCP processing during setup phase
    let mcpResult = null;
    try {
      console.log('🚀 Starting MCP processing...');
      
      const orchestrator = new MCPOrchestrator();
      const mcpOptions = {
        auth_token: mcp_options.auth_token || null,
        model: modelData.model,
        max_tools: mcp_options.max_tools || 3,
        include_reasoning: mcp_options.include_reasoning !== false,
        stream_response: false // Not streaming during setup
      };
      
      const query = opts.query || ctx.messages[ctx.messages.length - 1].content;
      
      mcpResult = await orchestrator.processQuery(query, mcpOptions);
      console.log(`✅ MCP processing ${mcpResult?.success ? 'completed' : 'failed'} (${mcpResult?.tools_used?.length || 0} tools)`);
      
    } catch (error) {
      console.error(`⚠️ MCP setup failed: ${error.message}`);
      mcpResult = {
        success: false,
        error: error.message,
        error_type: error.name || 'MCPSetupError',
        tools_used: [],
        tool_results: [],
        tool_errors: [{ error: error.message }],
        metadata: {
          processing_time_ms: 0,
          mcp_server_healthy: false
        }
      };
    }

    // Store setup data for streaming (including pre-processed MCP results)
    const setupData = {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      assistantMessageId,
      save_chat,
      session_id,
      user_id,
      mcpResult, // Pre-processed MCP results
      query: opts.query || ctx.messages[ctx.messages.length - 1].content
    };

    await streamStore.set(streamId, setupData);

    return {
      stream_id: streamId,
      assistant_message_id: assistantMessageId,
      model: modelData.model
    };
  } catch (error) {
    console.error('Error setting up MCP stream:', error);
    if (error instanceof LLMServiceError || error instanceof MCPError) {
      throw error;
    }
    throw new LLMServiceError('Failed to setup MCP stream', error);
  }
}

async function handleCopilotMCPStreamRequest(setupData, res) {
  let keepAliveInterval = null;
  let assistantText = '';
  
  try {
    const {
      ctx,
      modelData,
      assistantMessageId,
      save_chat,
      session_id,
      user_id,
      mcpResult,
      query
    } = setupData;

    // Start keep-alive
    keepAliveInterval = startKeepAlive(res);

    // Send pre-processed MCP results
    res.write(`event: mcp_start\ndata: ${JSON.stringify({ message: 'Using pre-processed MCP results...' })}\n\n`);
    
    // Send MCP results
    res.write(`event: mcp_result\ndata: ${JSON.stringify({
      success: mcpResult.success,
      tools_used: mcpResult.tools_used,
      tool_results: mcpResult.tool_results,
      tool_errors: mcpResult.tool_errors,
      selection_reasoning: mcpResult.selection_reasoning,
      metadata: mcpResult.metadata
    })}\n\n`);

    if (!mcpResult.success) {
      // If MCP failed, still try to generate a helpful response
      assistantText = mcpResult.error || 'MCP tool processing failed';
      res.write(`event: assistant\ndata: ${JSON.stringify({ content: assistantText })}\n\n`);
    } else {
      // Stream the final response incorporating pre-processed MCP results
      const enhancedContext = {
        ...ctx,
        messages: [
          ...ctx.messages,
          {
            role: 'system',
            content: `Tool execution results: ${JSON.stringify(mcpResult, null, 2)}\n\nGenerate a natural language response incorporating these results.`
          }
        ]
      };

      res.write(`event: response_start\ndata: ${JSON.stringify({ message: 'Generating response...' })}\n\n`);

      // Stream the LLM response
      const streamCallback = (chunk) => {
        assistantText += chunk;
        res.write(`event: assistant\ndata: ${JSON.stringify({ content: chunk })}\n\n`);
      };

      await runModelStream(enhancedContext, modelData, streamCallback);
    }

    // Final message with complete data
    const assistantMessage = createMessage('assistant', assistantText, assistantMessageId);
    assistantMessage.mcp_metadata = {
      tools_used: mcpResult?.tools_used || [],
      tool_results: mcpResult?.tool_results || [],
      tool_errors: mcpResult?.tool_errors,
      selection_reasoning: mcpResult?.selection_reasoning,
      processing_time_ms: mcpResult?.metadata?.processing_time_ms,
      confidence: mcpResult?.metadata?.confidence
    };

    // Save to database
    if (save_chat) {
      await addMessagesToSession(session_id, [assistantMessage]);
    }

    // Send completion event
    res.write(`event: complete\ndata: ${JSON.stringify({
      message_id: assistantMessageId,
      session_id,
      mcp_metadata: assistantMessage.mcp_metadata
    })}\n\n`);

  } catch (error) {
    console.error('Error in MCP stream:', error);
    
    let errorMessage = 'An error occurred during MCP processing';
    let errorType = 'MCPStreamError';
    
    if (error instanceof MCPError) {
      errorMessage = error.message;
      errorType = 'MCPError';
    } else if (error instanceof ToolSelectorError) {
      errorMessage = error.message;
      errorType = 'ToolSelectorError';
    } else if (error instanceof MCPOrchestratorError) {
      errorMessage = error.message;
      errorType = 'MCPOrchestratorError';
    } else if (error instanceof LLMServiceError) {
      errorMessage = error.message;
      errorType = 'LLMServiceError';
    }

    sendSseError(res, errorMessage, errorType);
  } finally {
    // Cleanup
    if (keepAliveInterval) {
      stopKeepAlive(keepAliveInterval);
    }
    
    // Remove from store and end response
    // Note: streamStore uses database, not in-memory store, so we don't need to find by setupData
    // The streamId should be passed from the calling context or stored in setupData
    // For now, skip this cleanup as it's handled by TTL in the database
    
    res.end();
  }
}

module.exports = {
  setupCopilotMCPStream,
  handleCopilotMCPStreamRequest
};