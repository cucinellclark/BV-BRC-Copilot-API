// services/modelQueries.js

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
} = require('../llm/llmServices');
const { getModelData } = require('../chat/core/dbUtils');

const MAX_TOKEN_HEADROOM = 500;

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

module.exports = {
  getOpenaiClient,
  queryModel,
  queryRequest,
  runModel,
  runModelStream,
  getPathState
}; 