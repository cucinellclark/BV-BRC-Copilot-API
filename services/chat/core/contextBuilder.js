// services/contextBuilder.js

const { v4: uuidv4 } = require('uuid');
const {
  getModelData,
  getChatSession
} = require('./dbUtils');
const {
  queryChatOnly,
  queryChatImage,
  queryRag,
  LLMServiceError,
  postJson
} = require('../../llm/llmServices');
const { safeParseJson } = require('../utils/jsonUtils');

// Lightweight replica of chatService.createQueryFromMessages to avoid a circular
// dependency.  Falls back to a simple concatenation if the helper microservice
// is unavailable.
function createQueryFromMessages(query, messages, system_prompt, max_tokens = 40000) {
  return new Promise(async (resolve) => {
    try {
      const data = await postJson('http://0.0.0.0:5000/get_prompt_query', {
        query: query || '',
        messages: messages || [],
        system_prompt: system_prompt || '',
        max_tokens
      });
      return resolve(data.prompt_query);
    } catch (_) {
      // Fallback formatting
      const parts = [];
      if (system_prompt) parts.push(`System: ${system_prompt}`);
      (messages || []).forEach((m) => parts.push(`${m.role}: ${m.content}`));
      parts.push(`Current User Query: ${query}`);
      return resolve(parts.join('\n\n'));
    }
  });
}

// Small helper – duplicated from chatService so we avoid a circular dependency for now.
function createMessage(role, content) {
  return {
    message_id: uuidv4(),
    role,
    content,
    timestamp: new Date()
  };
}

/**
 * Prepare prompt context, perform query enhancement & optional RAG lookup, and
 * build the ctx object required by runModel / runModelStream.
 *
 * The returned object contains everything the caller needs to continue the flow
 * without duplicating logic across streaming & non-streaming code paths.
 */
async function prepareCopilotContext(opts) {
  try {
    const {
      query = '',
      model,
      session_id,
      user_id,
      system_prompt = '',
      include_history = true,
      rag_db = null,
      num_docs = 5,
      image = null,
      enhanced_prompt = null
    } = opts;

    // 1. Fetch model metadata
    const modelData = await getModelData(model);

    // 2. Conversation history
    const chatSession = await getChatSession(session_id);
    const history = chatSession?.messages || [];

    // 3. Build the instruction system prompt used for query enhancement
    const defaultInstructionPrompt =
      'You are an assistant that only outputs JSON. Do not write any explanatory text or natural language.\n' +
      'Your tasks are:\n' +
      '1. Store the original user query in the "query" field.\n' +
      '2. Rewrite the query as "enhancedQuery" by intelligently incorporating any *relevant* context provided, while preserving the original intent.\n' +
      '   - If the original query is vague (e.g., "describe this page") and appears to reference a page, tool, feature, or system, rewrite it to make the help-related intent clear.\n' +
      '   - If there is no relevant context or no need to enhance, copy the original query into "enhancedQuery".\n' +
      '3. Set "rag_helpdesk" to true if the query relates to helpdesk-style topics such as:\n' +
      '   - website functionality\n' +
      '   - troubleshooting\n' +
      '   - how-to questions\n' +
      '   - user issues or technical support needs\n' +
      '   - vague references to a page, tool, or feature that may require explanation or support\n' +
      '   - **any question mentioning the BV-BRC (Bacterial and Viral Bioinformatics Resource Center) or its functionality**\n\n';

    const contextAndFormatInstructions =
      '\n\nAdditional context for the page the user is on, as well as relevant data, is provided below. Use it only if it helps clarify or improve the query:\n' +
      `${system_prompt}\n\n` +
      'Return ONLY a JSON object in the following format:\n' +
      '{\n' +
      '  "query": "<original user query>",\n' +
      '  "enhancedQuery": "<rewritten or same query>",\n' +
      '  "rag_helpdesk": <true or false>\n' +
      '}';

    const instructionSystemPrompt = (enhanced_prompt || defaultInstructionPrompt) + contextAndFormatInstructions;

    // 4. Query the LLM (image-aware if needed) to get enhancement JSON
    let instructionResponse;
    if (image) {
      instructionResponse = await queryChatImage({
        url: modelData.endpoint,
        model,
        query,
        image,
        system_prompt: instructionSystemPrompt
      });
    } else {
      instructionResponse = await queryChatOnly({
        query,
        model,
        system_prompt: instructionSystemPrompt,
        modelData
      });
    }

    const parsed = safeParseJson(instructionResponse) || {
      query,
      enhancedQuery: query,
      rag_helpdesk: false
    };

    const finalQuery     = parsed.enhancedQuery || query;
    const useHelpdeskRag = !!parsed.rag_helpdesk;
    const activeRagDb    = useHelpdeskRag ? 'bvbrc_helpdesk' : null;

    // 5. RAG retrieval
    let ragDocs = null;
    if (activeRagDb) {
      const { documents = ['No documents found'] } = await queryRag(finalQuery, activeRagDb, user_id, model, num_docs, session_id);
      ragDocs = documents;
    }
    if (rag_db && rag_db !== 'bvbrc_helpdesk') {
      const { documents = ['No documents found'] } = await queryRag(finalQuery, rag_db, user_id, model, num_docs, session_id);
      ragDocs = ragDocs ? ragDocs.concat(documents) : documents;
    }

    // 6. Build the prompt (history + RAG docs)
    const max_tokens = 40000;
    let promptWithHistory = finalQuery;

    if (include_history && history.length > 0) {
      try {
        promptWithHistory = await createQueryFromMessages(finalQuery, history, system_prompt, max_tokens);
      } catch (_) {
        // fall back to the original query if helper fails
      }
    }

    if (ragDocs) {
      if (include_history && history.length > 0) {
        promptWithHistory = `${promptWithHistory}\n\nRAG retrieval results:\n${ragDocs.join('\n\n')}`;
      } else {
        promptWithHistory = `Current User Query: ${finalQuery}\n\nRAG retrieval results:\n${ragDocs.join('\n\n')}`;
      }
    }

    // 7. Assemble ctx object for downstream model helpers
    const ctx = {
      prompt: promptWithHistory,
      systemPrompt: system_prompt,
      model,
      image,
      ragDocs
    };

    // 8. Build initial message objects (user + optional system)
    const userMessage = createMessage('user', query);

    let systemMessage = null;
    if (system_prompt && system_prompt.trim() !== '') {
      systemMessage = createMessage('system', system_prompt);
      if (ragDocs) systemMessage.documents = ragDocs;
      const details = `Enhanced User Query: ${finalQuery}\n\nInstruction System Prompt: ${instructionSystemPrompt}`;
      systemMessage.copilotDetails = details;
    }

    return {
      ctx,
      modelData,
      userMessage,
      systemMessage,
      chatSession,
      history
    };
  } catch (error) {
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to prepare copilot context', error);
  }
}

module.exports = {
  prepareCopilotContext
}; 