const config = require('../../config.json');
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

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (shouldExcludeMessage(msg)) {
      excludedCount++;
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

