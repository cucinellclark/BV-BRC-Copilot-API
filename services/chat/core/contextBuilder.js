// services/contextBuilder.js

const config = require('../../../config.json');
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
const mcpClient = require('../../mcp/mcpClient');
const mcpConfig = require('../../mcp/config.json');

// Lightweight replica of chatService.createQueryFromMessages to avoid a circular
// dependency.  Falls back to a simple concatenation if the helper microservice
// is unavailable.
function createQueryFromMessages(query, messages, system_prompt, max_tokens = 40000) {
  return new Promise(async (resolve) => {
    try {
      const data = await postJson(`${config.utilities_url}/get_prompt_query`, {
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
 * Build comprehensive MCP system prompt with clear usage instructions
 */
function buildMCPSystemPrompt(availableTools, system_prompt) {
  if (availableTools.length === 0) {
    return system_prompt;
  }

  const toolDescriptions = availableTools.map(tool => 
    `- ${tool.name} (${tool.server}): ${tool.description}`
  ).join('\n');

  const toolUsageInstructions = `
You have access to the following tools. When you need to use a tool, format your call exactly like this:
[TOOL:toolName:{"param1":"value1","param2":"value2"}]

Available tools:
${toolDescriptions}

IMPORTANT: 
- Use tools when they can help answer the user's question
- Do NOT describe or explain the tools unless specifically asked
- Do NOT mention tool names in your response unless using them
- Format tool calls exactly as shown above
- Continue your response after the tool call

Example usage:
User: "Search for E. coli genomes"
Assistant: I'll search for E. coli genomes for you.
[TOOL:data_server:search_genomes:{"query":"E. coli","limit":10}]
Based on the search results...`;

  return system_prompt + '\n\n' + toolUsageInstructions;
}

// Create an MCP chunk processor that can be used during streaming
// Identification (parsing) and execution of tool calls happen here.
function createMcpChunkProcessor() {
  return async function processMcpChunk(text, emit) {
    try {
      const toolCalls = mcpClient.extractToolCalls(text);

      if (!toolCalls || toolCalls.length === 0) {
        if (emit && typeof emit.token === 'function' && text) {
          await emit.token(text);
        }
        return;
      }

      let remainingText = text;
      for (const toolCall of toolCalls) {
        // Notify start
        if (emit && typeof emit.tool_start === 'function') {
          await emit.tool_start({
            tool: toolCall.toolName,
            server: toolCall.serverName,
            parameters: toolCall.parameters
          });
        }

        try {
          const startTime = Date.now();
          const result = await mcpClient.executeTool(
            toolCall.serverName,
            toolCall.toolName,
            toolCall.parameters
          );
          const executionTime = Date.now() - startTime;
          mcpClient.trackToolUsage(toolCall.toolName, toolCall.serverName, true, executionTime);

          // Remove tool call token from text
          remainingText = remainingText.replace(toolCall.fullMatch, '');

          if (emit && typeof emit.tool_result === 'function') {
            await emit.tool_result({
              tool: toolCall.toolName,
              server: toolCall.serverName,
              result
            });
          }
        } catch (err) {
          mcpClient.trackToolUsage(toolCall.toolName, toolCall.serverName, false, 0);
          if (emit && typeof emit.tool_error === 'function') {
            await emit.tool_error({
              tool: toolCall.toolName,
              server: toolCall.serverName,
              error: err && err.message ? err.message : 'Unknown MCP error'
            });
          }
        }
      }

      // Emit any remaining text after removing tool call tokens
      const trimmed = (remainingText || '').trim();
      if (trimmed && emit && typeof emit.token === 'function') {
        await emit.token(remainingText);
      }
    } catch (_) {
      // On parser failures, fall back to emitting the raw text
      if (emit && typeof emit.token === 'function' && text) {
        await emit.token(text);
      }
    }
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
      enhanced_prompt = null,
      auth_token = null
    } = opts;

    // 1. Fetch model metadata
    const modelData = await getModelData(model);

    // 2. Conversation history
    const chatSession = await getChatSession(session_id);
    const history = chatSession?.messages || [];

    // 3. Get available MCP tools for preparation prompt and build the instruction system prompt
    const availableTools = mcpClient.getAvailableTools();
    const toolOptions = availableTools.map(t => `- ${t.name} (${t.description})`).join('\n');

    // 4. Build the instruction system prompt used for query enhancement
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
      '   - **any question mentioning the BV-BRC (Bacterial and Viral Bioinformatics Resource Center) or its functionality**\n\n' + 
      '4. If a tool is required, set "tool_name" to exactly one of the available tool names listed below AND set "tool_parameters" to a JSON object matching that tool\'s expected inputs. If no tool is appropriate, set "tool_name" to an empty string and "tool_parameters" to {}. Do not mention tools unless selecting one.\n\n';

    const contextAndFormatInstructions =
      '\n\nAdditional context for the page the user is on, as well as relevant data, is provided below. Use it only if it helps clarify or improve the query:\n' +
      `${system_prompt}\n\n` +
      (availableTools.length > 0 ? ('Available tools (choose tool_name from these options):\n' + toolOptions + '\n\n') : '') +
      'Return ONLY a JSON object in the following format:\n' +
      '{\n' +
      '  "query": "<original user query>",\n' +
      '  "enhancedQuery": "<rewritten or same query>",\n' +
      '  "rag_helpdesk": <true or false>\n' +
      '  "tool_name": "<exact tool name from Available tools or empty>",\n' +
      '  "tool_parameters": { <key-value parameters for the selected tool or empty> }'
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

    console.log('instructionResponse', instructionResponse);

    const parsed = safeParseJson(instructionResponse) || {
      query,
      enhancedQuery: query,
      rag_helpdesk: false
    };

    const finalQuery     = parsed.enhancedQuery || query;
    const useHelpdeskRag = !!parsed.rag_helpdesk;
    const activeRagDb    = useHelpdeskRag ? 'bvbrc_helpdesk' : null;
    const toolName       = (parsed.tool_name || '').trim() || null;
    const toolParams     = parsed.tool_parameters && typeof parsed.tool_parameters === 'object' ? parsed.tool_parameters : {};

    // Execute selected tool (if any) during preparation
    const toolsUsed = [];
    let toolResultBlock = '';
    if (toolName) {
      const toolInfo = mcpClient.getToolByName(toolName);
      console.log('toolInfo', toolInfo);
      if (toolInfo && toolInfo.serverName) {
        try {
          // Include auth token only for allowed servers
          const allowlist = (mcpConfig && mcpConfig.global_settings && Array.isArray(mcpConfig.global_settings.token_server_allowlist))
            ? mcpConfig.global_settings.token_server_allowlist
            : [];
          
          if (auth_token && allowlist.includes(toolInfo.serverName)) {
            toolParams.token = auth_token;
          }
          const startTime = Date.now();
          const result = await mcpClient.executeTool(toolInfo.serverName, toolName, toolParams);
          const executionTime = Date.now() - startTime;
          mcpClient.trackToolUsage(toolName, toolInfo.serverName, true, executionTime);
          toolsUsed.push({ name: toolName, server: toolInfo.serverName, parameters: toolParams });
          // Append tool result to be available to the chat model
          let resultText;
          try {
            resultText = typeof result === 'string' ? result : JSON.stringify(result);
          } catch (_) {
            resultText = String(result);
          }
          toolResultBlock = `\n\nTool execution result (${toolName} @ ${toolInfo.serverName}):\n${resultText}`;
        } catch (err) {
          mcpClient.trackToolUsage(toolName, toolInfo.serverName, false, 0);
        }
      }
    }

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

    // 6. Build the prompt (history + RAG docs + tool results if any)
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

    if (toolResultBlock) {
      promptWithHistory = `${promptWithHistory}${toolResultBlock}`;
    }

    // 8. Build chat system prompt with answer policy prioritizing MCP results over RAG
    const answerPolicy = 'Answer policy:\n'
      + "- When a 'Tool execution result' section is present, base the answer primarily on it.\n"
      + "- Treat any 'RAG retrieval results' as supplemental context only; never contradict or override the tool result.\n"
      + "- If there is any conflict, prefer the tool result and keep the answer concise.\n"
      + "- Do not output commands, tool names, or document excerpts; return only the final answer.";

    const enhancedSystemPrompt = `${system_prompt}\n\n${answerPolicy}`;

    // 9. Assemble ctx object for downstream model helpers
    const ctx = {
      prompt: promptWithHistory,
      systemPrompt: enhancedSystemPrompt,
      model,
      image,
      ragDocs
    };

    // 9. Build initial message objects (user + optional system)
    const userMessage = createMessage('user', query);

    let systemMessage = null;
    if (system_prompt && system_prompt.trim() !== '') {
      systemMessage = createMessage('system', enhancedSystemPrompt);
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
      history,
      toolsUsed
    };
  } catch (error) {
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to prepare copilot context', error);
  }
}

module.exports = {
  prepareCopilotContext
}; 