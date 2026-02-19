const config = require('../../config.json');
const mcpConfig = require('../mcp/config.json');
const { getChatSession, getSummaryBySessionId } = require('../dbUtils');
const { createLogger } = require('../logger');

const logger = createLogger('ConversationContext');

const DEFAULT_TOKEN_LIMIT = config.llamaindex?.default_token_limit || 40000;
const DEFAULT_TOKEN_HEADROOM = 1500;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content);
  }
}

/**
 * Check if a tool result should cause message exclusion
 * @param {Object} traceEntry - Entry from agent_trace
 * @returns {boolean} - True if this trace entry should trigger exclusion
 */
function shouldExcludeByToolResult(traceEntry) {
  if (!traceEntry || !traceEntry.action) return false;
  
  const excludeConfig = mcpConfig.global_settings?.exclude_from_context || {};
  const unconditional = excludeConfig.unconditional || [];
  const conditional = excludeConfig.conditional || {};
  
  // Check unconditional exclusions (tools that should always be excluded)
  for (const toolName of unconditional) {
    if (traceEntry.action.includes(toolName)) {
      return true;
    }
  }
  
  // Check conditional exclusions (tools excluded based on result_type)
  for (const [toolName, conditions] of Object.entries(conditional)) {
    if (traceEntry.action.includes(toolName)) {
      const resultTypes = conditions.result_types || [];
      if (resultTypes.length === 0) continue;
      
      let resultType = null;

      // New lightweight metadata path.
      if (traceEntry.result_meta && typeof traceEntry.result_meta.result_type === 'string') {
        resultType = traceEntry.result_meta.result_type;
      }
      // Backward compatibility for older traces that still include full result payloads.
      else if (traceEntry.result) {
        // Direct result_type field
        if (traceEntry.result.result_type) {
          resultType = traceEntry.result.result_type;
        }
        // Nested in result.result.result_type (from file_reference)
        else if (traceEntry.result.result && traceEntry.result.result.result_type) {
          resultType = traceEntry.result.result.result_type;
        }
      }

      // Exclude if result_type matches any of the configured types
      if (resultType && resultTypes.includes(resultType)) {
        return true;
      }
    }
  }
  
  return false;
}

function shouldExcludeMessage(message) {
  if (!message || !message.role) return true;
  if (message.role === 'system') {
    return true;
  }
  if (message.agent_trace || message.tool_results_summary || message.documents) {
    return true;
  }
  return false;
}

function selectRecentMessages(messages, maxTokens) {
  const selected = [];
  let usedTokens = 0;
  let excludedCount = 0;
  let nextAssistantShouldBeExcluded = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // Check if the current message should be excluded based on basic criteria
    if (shouldExcludeMessage(msg)) {
      excludedCount++;
      
      // If this is a system message with agent_trace, check if any tool result should be excluded from context
      if (msg.agent_trace && Array.isArray(msg.agent_trace)) {
        for (const traceEntry of msg.agent_trace) {
          if (shouldExcludeByToolResult(traceEntry)) {
            // Mark that the next assistant message (going backwards) should be excluded
            nextAssistantShouldBeExcluded = true;
            break;
          }
        }
      }
      
      continue;
    }
    
    // Check if this assistant message should be excluded due to excluded tool usage
    if (msg.role === 'assistant' && nextAssistantShouldBeExcluded) {
      excludedCount++;
      nextAssistantShouldBeExcluded = false; // Reset the flag
      continue;
    }
    
    const content = normalizeContent(msg.content);
    const msgTokens = estimateTokens(content) + 10;
    if (usedTokens + msgTokens > maxTokens) {
      logger.debug('Token limit reached when selecting recent messages', {
        usedTokens,
        maxTokens,
        selectedCount: selected.length,
        excludedCount
      });
      break;
    }
    selected.push({
      role: msg.role,
      content
    });
    usedTokens += msgTokens;
  }

  logger.debug('Selected recent messages', {
    totalMessages: messages.length,
    selectedCount: selected.length,
    excludedCount,
    usedTokens,
    maxTokens
  });

  return selected.reverse();
}

function buildHistoryText(summary, recentMessages) {
  const parts = [];
  if (summary) {
    parts.push(`Conversation Summary:\n${summary.trim()}`);
  }
  if (recentMessages.length > 0) {
    const lines = recentMessages.map((m) => `${m.role}: ${m.content}`);
    parts.push(`Recent Messages:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function buildConversationContext(opts = {}) {
  const startTime = Date.now();
  const {
    session_id,
    user_id,
    query = '',
    system_prompt = '',
    include_history = true,
    token_limit = DEFAULT_TOKEN_LIMIT,
    summary_token_limit = config.conversation?.summary?.max_tokens || 1200,
    recent_token_limit = config.conversation?.recent?.max_tokens || 4000,
    token_headroom = DEFAULT_TOKEN_HEADROOM,
    chatSession = null,
    summaryDoc = null
  } = opts;

  logger.debug('Building conversation context', {
    session_id,
    user_id,
    include_history,
    hasChatSession: !!chatSession,
    hasSummaryDoc: !!summaryDoc,
    queryLength: query.length
  });

  if (!include_history || !session_id) {
    logger.debug('Skipping history (include_history=false or no session_id)', { session_id, include_history });
    return {
      prompt: query,
      messages: [{ role: 'user', content: query }],
      summaryUsed: false,
      recentMessages: []
    };
  }

  try {
    const session = chatSession || await getChatSession(session_id);
    const summary = summaryDoc || await getSummaryBySessionId(session_id);
    const messages = session?.messages || [];

    logger.debug('Loaded session data', {
      session_id,
      messageCount: messages.length,
      hasSummary: !!summary?.summary,
      summarizedCount: summary?.messages_summarized_count || 0
    });

    const queryTokens = estimateTokens(query);
    const availableTokens = Math.max(0, token_limit - token_headroom - queryTokens);
    const summaryTokens = Math.min(summary_token_limit, availableTokens);
    const recentTokens = Math.max(0, availableTokens - summaryTokens);

    logger.debug('Token budget allocation', {
      token_limit,
      token_headroom,
      queryTokens,
      availableTokens,
      summaryTokens,
      recentTokens
    });

    const summaryText = summary?.summary
      ? truncateToTokens(summary.summary, summaryTokens)
      : '';

    const recentMessages = selectRecentMessages(messages, Math.min(recent_token_limit, recentTokens));

    const historyText = buildHistoryText(summaryText, recentMessages);

    const promptParts = [];
    if (historyText) {
      promptParts.push(historyText);
    }
    promptParts.push(`Current Query: ${query}`);

    const prompt = promptParts.join('\n\n');

    const messagesForChat = [];
    if (system_prompt && system_prompt.trim() !== '') {
      messagesForChat.push({ role: 'system', content: system_prompt });
    }
    if (summaryText) {
      messagesForChat.push({ role: 'system', content: `Conversation summary:\n${summaryText}` });
    }
    recentMessages.forEach((m) => {
      if (m.role === 'user' || m.role === 'assistant') {
        messagesForChat.push({ role: m.role, content: m.content });
      }
    });
    messagesForChat.push({ role: 'user', content: query });

    const finalPromptTokens = estimateTokens(prompt);
    const duration = Date.now() - startTime;

    logger.info('Conversation context built successfully', {
      session_id,
      summaryUsed: !!summaryText,
      summaryLength: summaryText.length,
      recentMessageCount: recentMessages.length,
      totalMessagesInSession: messages.length,
      finalPromptTokens,
      messagesForChatCount: messagesForChat.length,
      durationMs: duration
    });

    return {
      prompt,
      messages: messagesForChat,
      summaryUsed: !!summaryText,
      recentMessages,
      historyText
    };
  } catch (error) {
    logger.error('Failed to build conversation context', {
      session_id,
      error: error.message,
      stack: error.stack
    });
    // Fallback: return minimal context
    return {
      prompt: query,
      messages: [{ role: 'user', content: query }],
      summaryUsed: false,
      recentMessages: []
    };
  }
}

module.exports = {
  buildConversationContext,
  buildHistoryText,
  selectRecentMessages
};

