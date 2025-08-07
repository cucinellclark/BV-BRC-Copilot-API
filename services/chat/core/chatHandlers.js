// services/chatHandlers.js

const { v4: uuidv4 } = require('uuid');
const { LLMServiceError } = require('./llmServices');
const {
  getModelData,
  getChatSession,
  createChatSession,
  addMessagesToSession
} = require('./dbUtils');
const { prepareCopilotContext } = require('./contextBuilder');
const { runModel } = require('../../queries/modelQueries');
const { createMessage, createQueryFromMessages } = require('../utils/messageUtils');
const {
  queryRequestEmbedding,
  queryRequestChat,
  queryChatImage,
  queryRag,
  queryLambdaModel,
  queryChatOnly,
  setupOpenaiClient,
  queryClient,
  LLMServiceError
} = require('../../llm/llmServices');
const config = require('../config.json');

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
      system_prompt = 'You are a helpful assistant that can answer questions.';
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

    var prompt_query = 'RAG retrieval results:\n' + documents.join('\n\n');
    prompt_query = "Current User Query: " + query + "\n\n" + prompt_query;
    var system_prompt = "You are a helpful AI assistant that can answer questions." + 
     "You are given a list of documents and a user query. " +
     "You need to answer the user query based on the documents if those documents are relevant to the user query. " +
     "If they are not relevant, you need to answer the user query based on your knowledge. ";

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

module.exports = {
  handleCopilotRequest,
  handleChatRequest,
  handleRagRequest,
  handleChatImageRequest,
  handleLambdaDemo,
  handleChatQuery
}; 