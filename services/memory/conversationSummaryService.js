const config = require('../../config.json');
const { getChatSession, getSummaryBySessionId, saveSummaryDoc, getModelData } = require('../dbUtils');
const { queryChatOnly, LLMServiceError } = require('../llmServices');
const { createLogger } = require('../logger');

const logger = createLogger('ConversationSummary');

const SUMMARY_VERSION = 'v1';

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content);
  }
}

function formatMessagesForSummary(messages, maxCharsPerMessage = 1200) {
  return messages.map((m) => {
    const role = m.role || 'user';
    const content = normalizeContent(m.content);
    const trimmed = content.length > maxCharsPerMessage
      ? content.slice(0, maxCharsPerMessage)
      : content;
    return `${role}: ${trimmed}`;
  }).join('\n');
}

function buildSummaryPrompt(previousSummary, newMessages) {
  const summaryIntro = previousSummary
    ? `Previous summary:\n${previousSummary}\n\n`
    : '';

  const messageBlock = formatMessagesForSummary(newMessages);
  return (
    `${summaryIntro}` +
    `New conversation turns:\n${messageBlock}\n\n` +
    `Write a concise, factual running summary of the conversation so far. ` +
    `Include user goals, key decisions, important entities/IDs, and open questions. ` +
    `Do not include tool execution traces or implementation details unless the user requested them.`
  );
}

async function generateSummaryForSession(session_id, user_id) {
  const startTime = Date.now();
  
  try {
    logger.debug('Starting summary generation', { session_id, user_id });

    if (!session_id) {
      throw new LLMServiceError('Session ID is required for summary generation');
    }

    const session = await getChatSession(session_id);
    if (!session || !Array.isArray(session.messages)) {
      logger.debug('Skipping summary: no messages', { session_id, hasSession: !!session });
      return { skipped: true, reason: 'no_messages' };
    }

    const minMessages = config.conversation?.summarization?.min_messages_for_summary || 10;
    if (session.messages.length < minMessages) {
      logger.debug('Skipping summary: not enough messages', {
        session_id,
        messageCount: session.messages.length,
        minMessages
      });
      return { skipped: true, reason: 'not_enough_messages' };
    }

    const summaryDoc = await getSummaryBySessionId(session_id);
    const summarizedCount = summaryDoc?.messages_summarized_count || 0;

    logger.debug('Summary state check', {
      session_id,
      totalMessages: session.messages.length,
      summarizedCount,
      hasPreviousSummary: !!summaryDoc?.summary
    });

    if (summarizedCount >= session.messages.length) {
      logger.debug('Skipping summary: already up to date', {
        session_id,
        totalMessages: session.messages.length,
        summarizedCount
      });
      return { skipped: true, reason: 'up_to_date' };
    }

    const newMessages = session.messages.slice(summarizedCount);
    if (newMessages.length === 0) {
      logger.debug('Skipping summary: no new messages', { session_id });
      return { skipped: true, reason: 'no_new_messages' };
    }

    const summaryModel = config.conversation?.summarization?.model
      || config.llamaindex?.llm_model
      || 'gpt-4o-mini';

    logger.info('Generating summary', {
      session_id,
      totalMessages: session.messages.length,
      newMessageCount: newMessages.length,
      summarizedCount,
      summaryModel,
      hasPreviousSummary: !!summaryDoc?.summary
    });

    const modelData = await getModelData(summaryModel);
    const prompt = buildSummaryPrompt(summaryDoc?.summary || '', newMessages);

    logger.debug('Calling LLM for summary', {
      session_id,
      promptLength: prompt.length,
      model: summaryModel
    });

    const llmStartTime = Date.now();
    const summary = await queryChatOnly({
      query: prompt,
      model: summaryModel,
      system_prompt: 'You are a helpful assistant that creates concise conversation summaries.',
      modelData
    });
    const llmDuration = Date.now() - llmStartTime;

    const summaryText = typeof summary === 'string' ? summary.trim() : String(summary);
    
    logger.debug('LLM summary received', {
      session_id,
      summaryLength: summaryText.length,
      llmDurationMs: llmDuration
    });

    await saveSummaryDoc(session_id, user_id || session.user_id, {
      summary: summaryText,
      messages_summarized_count: session.messages.length,
      summary_version: SUMMARY_VERSION,
      summary_model: summaryModel
    });

    const totalDuration = Date.now() - startTime;

    logger.info('Summary generated and saved successfully', {
      session_id,
      summaryLength: summaryText.length,
      messagesSummarized: session.messages.length,
      newMessagesSummarized: newMessages.length,
      llmDurationMs: llmDuration,
      totalDurationMs: totalDuration
    });

    return { skipped: false, summary: summaryText };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Summary generation failed', {
      session_id,
      user_id,
      error: error.message,
      stack: error.stack,
      durationMs: duration
    });
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to generate summary', error);
  }
}

module.exports = {
  generateSummaryForSession
};

