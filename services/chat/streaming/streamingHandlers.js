// services/streamingHandlers.js

const { v4: uuidv4 } = require('uuid');
const { LLMServiceError } = require('../../llm/llmServices');
const {
  getModelData,
  createChatSession,
  addMessagesToSession
} = require('../core/dbUtils');
const { prepareCopilotContext } = require('../core/contextBuilder');
const { runModel, runModelStream } = require('../../queries/modelQueries');
const { createMessage } = require('../utils/messageUtils');
const { sendSseError, startKeepAlive, stopKeepAlive, sendSseEvent, sendSseRetry } = require('./sseUtils');
const streamStore = require('./streamStore');

/**
 * Setup function that prepares message objects and context for streaming.
 * This separates the preparation logic from the actual streaming.
 */
async function setupCopilotStream(opts) {
  try {
    const {
      save_chat = true,
      session_id,
      user_id
    } = opts;

    // Build context (shared logic)
    const {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      chatSession
    } = await prepareCopilotContext(opts);

    // Remove the raw RAG docs from ctx to keep payload small/private
    if (ctx && ctx.ragDocs) delete ctx.ragDocs;

    // Create assistant message ID & stream ID
    const assistantMessageId = uuidv4();
    const streamId = uuidv4();

    // Persist initial messages before starting the stream
    if (save_chat) {
      if (!chatSession) await createChatSession(session_id, user_id);
      const initialMsgs = systemMessage ? [userMessage, systemMessage] : [userMessage];
      await addMessagesToSession(session_id, initialMsgs);
    }

    // Clone systemMessage without large docs to store
    let sysMsgForStore = null;
    if (systemMessage) {
      sysMsgForStore = { ...systemMessage };
      if (sysMsgForStore.documents) delete sysMsgForStore.documents;
    }

    // Store data in fast in-memory store (TTL cleanup handled inside)
    const storePayload = {
      stream_id: streamId,
      ctx,
      modelData,
      userMessage,
      systemMessage: sysMsgForStore,
      assistantMessage: { message_id: assistantMessageId },
      save_chat,
      session_id
    };
    streamStore.set(streamId, storePayload);

    return {
      stream_id: streamId,
      userMessage,
      assistantMessage: { message_id: assistantMessageId },
      systemMessage,
      rag_docs: systemMessage && systemMessage.documents ? systemMessage.documents : null,
      copilot_details: systemMessage && systemMessage.copilotDetails ? systemMessage.copilotDetails : null,
      user_content: userMessage.content,
      system_prompt: systemMessage ? systemMessage.content : null
    };
  } catch (error) {
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to setup copilot stream', error);
  }
}

/**
 * SSE-enabled version of handleCopilotRequest. Writes chunks directly to `res`.
 * Now accepts prepared setup data instead of doing the setup itself.
 */
async function handleCopilotStreamRequest(streamData, res) {
  try {
    // Handle case where streamData might be a Promise (defensive programming)
    if (streamData && typeof streamData.then === 'function') {
      console.warn('streamData is a Promise, awaiting it...');
      streamData = await streamData;
    }

    const {
      stream_id,
      ctx,
      modelData,
      userMessage,
      systemMessage,
      assistantMessage,
      save_chat,
      session_id
    } = streamData;

    const assistantMessageId = assistantMessage.message_id;

    // Send message metadata first (IDs only for clean JSON)
    const messageMetadata = {
      type: 'message_metadata',
      user_message_id: userMessage.message_id,
      assistant_message_id: assistantMessageId,
      ...(systemMessage && { system_message_id: systemMessage.message_id })
    };
    res.write(`data: ${JSON.stringify(messageMetadata)}\n\n`);
    if (typeof res.flush === 'function') res.flush();

    // Keep-alive
    const keepAliveId = startKeepAlive(res);

    let assistantBuffer = '';
    const onChunk = (text) => {
      assistantBuffer += text;
      const safeText = text.replace(/\n/g, '\\n');
      res.write(`data: ${safeText}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };

    await runModelStream(ctx, modelData, onChunk);

    // Stream completed
    res.write('data: [DONE]\n\n');
    if (typeof res.flush === 'function') res.flush();
    res.end();

    stopKeepAlive(keepAliveId);

    // Persist assistant message with the pre-created ID
    if (save_chat) {
      const assistantMessage = {
        message_id: assistantMessageId,
        role: 'assistant',
        content: assistantBuffer,
        timestamp: new Date()
      };
      await addMessagesToSession(session_id, [assistantMessage]);
    }

    // Remove stored setup data to free memory
    if (stream_id) {
      streamStore.remove(stream_id);
    }
  } catch (error) {
    console.error('Streaming copilot error:', error);
    sendSseError(res, 'Internal server error');
  }
}

/**
 * Single-call SSE handler. Performs setup and streams tokens under named events.
 */
async function startCopilotSse(opts, res) {
  let keepAliveId = null;
  try {
    const {
      save_chat = true,
      session_id,
      user_id
    } = opts || {};

    const {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      chatSession
    } = await prepareCopilotContext(opts);

    if (save_chat) {
      if (!chatSession) await createChatSession(session_id, user_id);
      const initialMsgs = systemMessage ? [userMessage, systemMessage] : [userMessage];
      await addMessagesToSession(session_id, initialMsgs);
    }

    const assistantMessageId = uuidv4();

    // Initial handshake and retry suggestion
    sendSseRetry(res, 1500);
    sendSseEvent(res, 'open', { ok: true });

    // IDs metadata
    sendSseEvent(res, 'metadata', {
      user_message_id: userMessage.message_id,
      assistant_message_id: assistantMessageId,
      ...(systemMessage && { system_message_id: systemMessage.message_id })
    });

    if (systemMessage && Array.isArray(systemMessage.documents) && systemMessage.documents.length > 0) {
      sendSseEvent(res, 'rag_docs', { documents: systemMessage.documents });
    }
    if (systemMessage && systemMessage.copilotDetails) {
      sendSseEvent(res, 'copilot_details', { details: systemMessage.copilotDetails });
    }

    keepAliveId = startKeepAlive(res);
    res.on('close', () => {
      if (keepAliveId) stopKeepAlive(keepAliveId);
    });

    let assistantBuffer = '';
    const onChunk = (text) => {
      assistantBuffer += text;
      sendSseEvent(res, 'token', { text });
    };

    await runModelStream(ctx, modelData, onChunk);

    if (keepAliveId) stopKeepAlive(keepAliveId);
    sendSseEvent(res, 'done', { message_id: assistantMessageId, content: assistantBuffer });
    res.end();

    if (save_chat) {
      const assistantMessageFinal = {
        message_id: assistantMessageId,
        role: 'assistant',
        content: assistantBuffer,
        timestamp: new Date()
      };
      await addMessagesToSession(session_id, [assistantMessageFinal]);
    }
  } catch (error) {
    console.error('startCopilotSse error:', error);
    if (keepAliveId) stopKeepAlive(keepAliveId);
    sendSseError(res, (error && error.message) || 'Internal server error');
  }
}

module.exports = {
  setupCopilotStream,
  handleCopilotStreamRequest,
  startCopilotSse
}; 