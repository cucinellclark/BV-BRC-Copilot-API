// services/chatService.js

const { v4: uuidv4 } = require('uuid');
const { connectToDatabase } = require('../database');
const {
  setupOpenaiClient,
  queryClient,
  queryRequestChat,
  queryRequestEmbedding,
  queryRequestEmbeddingTfidf,
  queryLambdaModel,
  queryChatOnly,
  queryChatImage,
  queryRag,
  postJson,
  postJsonStream,
  LLMServiceError
} = require('./llmServices');
const {
  getModelData,
  getRagData,
  getChatSession,
  createChatSession,
  addMessagesToSession,
  getOrCreateChatSession,
  saveSummary
} = require('./dbUtils');
const { ChromaClient } = require('chromadb');
const fs = require('fs');

// === New helper modules (refactor) ===
const { safeParseJson } = require('./jsonUtils');
const { prepareCopilotContext } = require('./contextBuilder');
const { sendSseError, startKeepAlive, stopKeepAlive } = require('./sseUtils');
const promptManager = require('../prompts');

const MAX_TOKEN_HEADROOM = 500;

const config = require('../config.json');

// Helper function to create message objects with consistent structure
function createMessage(role, content, tokenCount) {
  return {
    message_id: uuidv4(),
    role,
    content,
    timestamp: new Date()
  };
}

function getOpenaiClient(modelData) {
  try {
    return setupOpenaiClient(modelData.apiKey, modelData.endpoint);
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to setup OpenAI client', error);
  }
}

async function queryModel(client, model, messages) {
  try {
    return await queryClient(client, model, messages);
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to query model', error);
  }
}

async function queryRequest(endpoint, model, systemPrompt, query) {
  try {
    return await queryRequestChat(endpoint, model, systemPrompt, query);
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to query request', error);
  }
}

async function runModel(ctx, modelData) {
  if (ctx.image) {
    return await queryChatImage({
      url: modelData.endpoint,
      model: ctx.model,
      query: ctx.prompt,
      image: ctx.image,
      system_prompt: ctx.systemPrompt
    });
  }
  if (modelData.queryType === 'client') {
    const client = setupOpenaiClient(modelData.apiKey, modelData.endpoint);
    return await queryClient(client, ctx.model, [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: ctx.prompt }
    ]);
  }
  if (modelData.queryType === 'request') {
    return await queryRequestChat(
      modelData.endpoint,
      ctx.model,
      ctx.systemPrompt,
      ctx.prompt
    );
  }
  throw new LLMServiceError(`Invalid queryType: ${modelData.queryType}`);
}

async function handleCopilotRequest(opts) {
  try {
    const {
      save_chat = true,
      session_id,
      user_id
    } = opts;

    // Build context (deduplicated logic)
    const {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      chatSession
    } = await prepareCopilotContext(opts);

    // Obtain assistant response in a single shot
    const assistantText = await runModel(ctx, modelData);
    const assistantMessage = createMessage('assistant', assistantText);

    // Persist conversation
    if (save_chat) {
      if (!chatSession) await createChatSession(session_id, user_id);
      const toInsert = systemMessage ? [userMessage, systemMessage, assistantMessage]
                                     : [userMessage, assistantMessage];
      await addMessagesToSession(session_id, toInsert);
    }

    return {
      message: 'success',
      userMessage,
      assistantMessage,
      ...(systemMessage && { systemMessage })
    };
  } catch (error) {
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to handle copilot request', error);
  }
}

async function handleChatRequest({ query, model, session_id, user_id, system_prompt, save_chat = true, include_history = true }) {
  try {
    const modelData = await getModelData(model);
    const max_tokens = 40000;
    const chatSession = await getChatSession(session_id);

    const llmMessages = []; // used for queryClient
    const userMessage = createMessage('user', query);
    //(url, model, apiKey, query)
    const embedding_url = config['embedding_url'];
    const embedding_model = config['embedding_model'];
    const embedding_apiKey = config['embedding_apiKey'];
    const user_embedding = await queryRequestEmbedding(embedding_url, embedding_model, embedding_apiKey, query);

    // Creates a system message recorded in the conversation history if system_prompt is provided
    let systemMessage = null;
    if (system_prompt && system_prompt.trim() !== '') {
      llmMessages.push({ role: 'system', content: system_prompt });
      systemMessage = createMessage('system', system_prompt);
    }

    // Get the conversation history from the database
    const chatSessionMessages = chatSession?.messages || [];
    
    llmMessages.push({ role: 'user', content: query });

    let prompt_query;
    if (include_history) {
      prompt_query = await createQueryFromMessages(query, chatSessionMessages, system_prompt || '', max_tokens);
    } else {
      prompt_query = query;
    }

    if (!system_prompt || system_prompt.trim() === '') {
      system_prompt = promptManager.getSystemPrompt('default');
    }

    let response;
    try {
      if (modelData.queryType === 'client') {
        const openai_client = setupOpenaiClient(modelData.apiKey, modelData.endpoint);
        response = await queryClient(openai_client, model, llmMessages);
      } else if (modelData.queryType === 'request') {
        response = await queryRequestChat(modelData.endpoint, model, system_prompt || '', prompt_query);
      } else {
        throw new LLMServiceError(`Invalid queryType: ${modelData.queryType}`);
      }
    } catch (error) {
      if (error instanceof LLMServiceError) {
        throw error;
      }
      throw new LLMServiceError('Failed to get model response', error);
    }

    const assistantMessage = createMessage('assistant', response);
    const assistant_embedding = await queryRequestEmbedding(embedding_url, embedding_model, embedding_apiKey, response);

    // Use database utility functions for session management
    if (!chatSession && save_chat) {
      await createChatSession(session_id, user_id);
    }

    const messagesToInsert = systemMessage
      ? [userMessage, systemMessage, assistantMessage]
      : [userMessage, assistantMessage];

    if (save_chat) {
      await addMessagesToSession(session_id, messagesToInsert);
    }

    return { 
      message: 'success', 
      userMessage,
      assistantMessage,
      ...(systemMessage && { systemMessage })
    };
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to handle chat request', error);
  }
}

async function handleRagRequest({ query, rag_db, user_id, model, num_docs, session_id, save_chat = true, include_history = false }) {
  try {
    const modelData = await getModelData(model);
    const chatSession = await getChatSession(session_id);
    const chatSessionMessages = chatSession?.messages || [];

    const userMessage = createMessage('user', query, 1);

    const embedding_url = config['embedding_url'];
    const embedding_model = config['embedding_model'];
    const embedding_apiKey = config['embedding_apiKey'];

    // embedding created in distllm
    var { documents, embedding: user_embedding } = await queryRag(query, rag_db, user_id, model, num_docs, session_id);

    if (!documents || documents.length === 0) {
      documents = ['No documents found'];
    }

    var prompt_query = promptManager.formatRagPrompt(query, documents);
    var system_prompt = promptManager.getSystemPrompt('rag');

    response = await handleChatQuery({ query: prompt_query, model, system_prompt: system_prompt || '' });

    if (!response) {
      response = 'No response from model';
    }

    // Create system message if system_prompt is provided
    let systemMessage = null;
    if (system_prompt) {
      systemMessage = createMessage('system', system_prompt);
      if (documents && documents.length > 0) {
        systemMessage.documents = documents;
      }
    }

    const assistantMessage = createMessage('assistant', response, 1);
    const assistant_embedding = await queryRequestEmbedding(embedding_url, embedding_model, embedding_apiKey, response);

    if (!chatSession && save_chat) {
      await createChatSession(session_id, user_id);
    }

    // Add system message to the messages array if it exists
    const messagesToInsert = systemMessage
      ? [userMessage, systemMessage, assistantMessage]
      : [userMessage, assistantMessage];

    if (save_chat) {
      await addMessagesToSession(session_id, messagesToInsert);
    }

    return { 
      message: 'success', 
      userMessage,
      assistantMessage,
      ...(systemMessage && { systemMessage })
    };
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to handle RAG request', error);
  }
}

async function handleChatImageRequest({ query, model, session_id, user_id, image, system_prompt, save_chat = true, include_history = false }) {
  try {
    const modelData = await getModelData(model);

    const chatSession = await getChatSession(session_id);

    const userMessage = createMessage('user', query);
    const embedding_url = config['embedding_url'];
    const embedding_model = config['embedding_model'];
    const embedding_apiKey = config['embedding_apiKey'];
    const user_embedding = await queryRequestEmbedding(embedding_url, embedding_model, embedding_apiKey, query);

    let systemMessage = null;
    if (system_prompt && system_prompt.trim() !== '') {
      systemMessage = createMessage('system', system_prompt);
    }
    if (!system_prompt) {
      system_prompt = "";
    }

    let response;
    try {
      response = await queryChatImage({
        url: modelData.endpoint,
        model,
        query: query,
        image: image,
        system_prompt: system_prompt
      });
    } catch (error) {
      if (error instanceof LLMServiceError) {
        throw error;
      }
      throw new LLMServiceError('Failed to get model response for image chat', error);
    }

    // Create system message if system_prompt is provided
    if (system_prompt) {
      systemMessage = createMessage('system', system_prompt);
    }

    const assistantMessage = createMessage('assistant', response);
    const assistant_embedding = await queryRequestEmbedding(embedding_url, embedding_model, embedding_apiKey, response);
    if (!chatSession && save_chat) {
      await createChatSession(session_id, user_id);
    }

    // Add system message to the messages array if it exists
    const messagesToInsert = systemMessage
      ? [userMessage, systemMessage, assistantMessage]
      : [userMessage, assistantMessage];

    if (save_chat) {
      await addMessagesToSession(session_id, messagesToInsert);
    }

    return { 
      message: 'success', 
      userMessage,
      assistantMessage,
      ...(systemMessage && { systemMessage })
    };
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    if (error.message.includes('Failed to get model response for image chat') || error.message.includes('Invalid model') || error.message.includes('Query text too long') || error.message.includes('Combined text prompt')) {
        throw error;
    }
    throw new LLMServiceError('Failed to handle chat image request', error);
  }
}

async function handleLambdaDemo(text, rag_flag) {
  try {
    const response = await queryLambdaModel(text, rag_flag);
    return response;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to handle Lambda demo request', error);
  }
}

async function handleChatQuery({ query, model, system_prompt = '' }) {
  try {
    const modelData = await getModelData(model);
    return await queryChatOnly({ query, model, system_prompt, modelData });
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to query chat', error);
  }
}

function createQueryFromMessages(query, messages, system_prompt, max_tokens) {
  return new Promise(async (resolve, reject) => {
    try {
      const data = await postJson('http://0.0.0.0:5000/get_prompt_query', {
        query: query || '',
        messages: messages || [],
        system_prompt: system_prompt || '',
        max_tokens: 40000
      });

      resolve(data.prompt_query);
    } catch (error) {
      console.error('Error in createQueryFromMessages:', error);
      
      // Fallback: format messages according to their roles
      let formattedMessages = [];
      
      // Add system prompt if provided
      if (system_prompt && system_prompt.trim() !== '') {
        formattedMessages.push(`System: ${system_prompt}`);
      }
      
      // Format existing messages according to their roles
      if (messages && messages.length > 0) {
        messages.forEach(msg => {
          if (msg.role && msg.content) {
            const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
            formattedMessages.push(`${roleLabel}: ${msg.content}`);
          }
        });
      }
      
      // Add the current query as the final message
      if (query && query.trim() !== '') {
        formattedMessages.push(`Current User Query: ${query}`);
      }
      
      const fallbackResponse = formattedMessages.join('\n\n');
      resolve(fallbackResponse);
    }
  });
}

async function getPathState(path) {
  try {
    const response = await postJson('http://0.0.0.0:5000/get_path_state', { path: path });
    return response;
  } catch (error) {
    if (error instanceof LLMServiceError) {
      throw error;
    }
    throw new LLMServiceError('Failed to get path state', error);
  }
}

// ========================================
// Query Enhancement Helper
// ========================================

/**
 * Enhance a user query by injecting relevant context from the system prompt or image.
 * The function uses an LLM to rewrite the query so that downstream models receive
 * a richer prompt while keeping the original intent intact. The LLM is instructed
 * to return ONLY the rewritten query text with no additional commentary.
 *
 * @param {string} originalQuery  - The user\'s original query.
 * @param {string} systemPrompt   - Additional textual context provided to the assistant.
 * @param {string|null} image     - Optional image (data-URI or public URL) supplied by the user.
 * @param {string} model          - The name of the model that will perform the rewrite.
 * @returns {Promise<string>} The enhanced query text.
 */
async function enhanceQuery(originalQuery, systemPrompt = '', image = null, model = null) {
  try {
    // If there is no extra context, return the query unchanged.
    if ((!systemPrompt || systemPrompt.trim() === '') && !image) {
      return originalQuery;
    }
    if (!model) {
      return originalQuery;
    }

    // Attempt to fetch model metadata; fall back gracefully if the model is unknown.
    let modelData;
    try {
      modelData = await getModelData(model);
    } catch (err) {
      console.warn(`[enhanceQuery] Unable to find model data for ${model}. Returning original query.`);
      return originalQuery;
    }

    // Instruction telling the model exactly how to behave.
    const enhancementInstruction = promptManager.getSimpleRewriteInstruction();

    // Build the user content that will be passed to the enhancement model.
    const userContent = image
      ? `Original user query:\n${originalQuery}` // For images the visual context is supplied separately.
      : `Original user query:\n${originalQuery}\n\nSystem prompt context:\n${systemPrompt}`;

    let rewrittenQuery;
    console.log('image', image);
    if (image) {
      // Use the image-capable chat endpoint when an image is present.
      rewrittenQuery = await queryChatImage({
        url: modelData.endpoint,
        model,
        query: userContent,
        image,
        system_prompt: enhancementInstruction + promptManager.getImageContextInstruction(systemPrompt)
      });
    } else {
      // Text-only path.
      rewrittenQuery = await queryChatOnly({
        query: userContent,
        model,
        system_prompt: enhancementInstruction,
        modelData
      });
    }

    return typeof rewrittenQuery === 'string' ? rewrittenQuery.trim() : originalQuery;
  } catch (error) {
    console.error('[enhanceQuery] Failed to enhance query:', error);
    // On failure, gracefully return the original query to avoid blocking the user.
    return originalQuery;
  }
}

// ========================================
// Streaming Helpers
// ========================================

/**
 * Stream responses from the underlying model. This mirrors `runModel` but
 * delivers chunks through the provided `onChunk` callback rather than returning
 * the full string.
 *
 * @param {object} ctx        – Same context object used by runModel
 * @param {object} modelData  – Metadata from getModelData()
 * @param {function(string)} onChunk – Callback for each text chunk
 */
async function runModelStream(ctx, modelData, onChunk) {
  if (ctx.image) {
    // Current image endpoints do not support streaming; fall back to a single shot
    const full = await runModel(ctx, modelData);
    onChunk(full);
    return;
  }

  // ---------------------- client-based models ----------------------
  if (modelData.queryType === 'client') {
    const client = setupOpenaiClient(modelData.apiKey, modelData.endpoint);
    const stream = await client.chat.completions.create({
      model: ctx.model,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        { role: 'user', content: ctx.prompt }
      ],
      stream: true
    });

    for await (const part of stream) {
      const text = part.choices?.[0]?.delta?.content;
      if (text) onChunk(text);
    }
    return;
  }

  // ---------------------- request-based models ----------------------
  if (modelData.queryType === 'request') {
    // Build the same payload used in runModel
    const payload = {
      model: ctx.model,
      temperature: 1.0,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        { role: 'user', content: ctx.prompt }
      ],
      stream: true
    };

    // Utilize streaming POST helper
    await postJsonStream(modelData.endpoint, payload, onChunk, modelData.apiKey);
    return;
  }

  throw new LLMServiceError(`Invalid queryType for streaming: ${modelData.queryType}`);
}

/**
 * SSE-enabled version of handleCopilotRequest. Writes chunks directly to `res`.
 */
async function handleCopilotStreamRequest(opts, res) {
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

    // Persist initial messages before starting the stream
    if (save_chat) {
      if (!chatSession) await createChatSession(session_id, user_id);
      const initialMsgs = systemMessage ? [userMessage, systemMessage] : [userMessage];
      await addMessagesToSession(session_id, initialMsgs);
    }

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

    // Persist assistant message
    if (save_chat) {
      const assistantMessage = createMessage('assistant', assistantBuffer);
      await addMessagesToSession(session_id, [assistantMessage]);
    }
  } catch (error) {
    console.error('Streaming copilot error:', error);
    sendSseError(res, 'Internal server error');
  }
}


module.exports = {
  // Core chat flows
  handleCopilotRequest,
  handleCopilotStreamRequest,
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

