const config = require('../../config.json');
const { queryChatOnly, LLMServiceError } = require('../llmServices');
const { getModelData } = require('../dbUtils');
const { getSessionMemory, updateSessionFacts } = require('./sessionMemoryService');
const { createLogger } = require('../logger');

const logger = createLogger('SessionFacts');

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content);
  }
}

function truncateString(value, maxLength) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function sanitizeToolResult(result, maxChars = 4000) {
  if (result == null) return '';
  const normalized = normalizeContent(result);
  return truncateString(normalized, maxChars);
}

function buildFactsPrompt({ previousFacts, userQuery, toolId, parameters, resultSummary }) {
  const previousFactsText = previousFacts && Object.keys(previousFacts).length > 0
    ? JSON.stringify(previousFacts, null, 2)
    : '{}';
  const paramsText = parameters && Object.keys(parameters).length > 0
    ? JSON.stringify(parameters, null, 2)
    : '{}';

  return (
    `You maintain a running JSON object of session facts. ` +
    `Update the facts using the latest context. ` +
    `Return ONLY a valid JSON object (no markdown, no commentary).\n\n` +
    `Rules:\n` +
    `- Keep existing facts unless contradicted by newer information.\n` +
    `- If new info conflicts, replace the old value.\n` +
    `- Prefer short, factual values. Use arrays for lists.\n` +
    `- Do not include tool traces or low-value counters.\n\n` +
    `PREVIOUS FACTS:\n${previousFactsText}\n\n` +
    `USER QUERY:\n${userQuery || ''}\n\n` +
    `TOOL:\n${toolId || ''}\n\n` +
    `PARAMETERS:\n${paramsText}\n\n` +
    `TOOL RESULT (summary):\n${resultSummary}\n`
  );
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n').slice(1);
    if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
      lines.pop();
    }
    return lines.join('\n').trim();
  }
  return trimmed;
}

async function generateSessionFactsUpdate({
  session_id,
  user_id,
  user_query,
  toolId,
  parameters,
  result,
  model
}) {
  const startTime = Date.now();
  try {
    if (!session_id) {
      throw new LLMServiceError('Session ID is required for session facts');
    }

    const memory = await getSessionMemory(session_id, user_id);
    const previousFacts = memory?.facts || {};
    const factsModel = model || config.conversation?.facts?.model || 'gpt-4o-mini';

    const resultSummary = sanitizeToolResult(result);
    const prompt = buildFactsPrompt({
      previousFacts,
      userQuery: user_query,
      toolId,
      parameters,
      resultSummary
    });

    logger.debug('Generating session facts', {
      session_id,
      toolId,
      model: factsModel,
      promptLength: prompt.length
    });

    const modelData = await getModelData(factsModel);
    const llmStart = Date.now();
    const response = await queryChatOnly({
      query: prompt,
      model: factsModel,
      system_prompt: 'You produce concise, factual JSON objects for session context.',
      modelData
    });
    const llmDuration = Date.now() - llmStart;

    const responseText = extractJson(typeof response === 'string' ? response : String(response));
    let facts;
    try {
      facts = JSON.parse(responseText);
    } catch (parseError) {
      logger.error('Failed to parse session facts JSON', {
        session_id,
        toolId,
        error: parseError.message,
        responsePreview: truncateString(responseText, 600)
      });
      throw new LLMServiceError('Session facts response was not valid JSON', parseError);
    }

    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
      throw new LLMServiceError('Session facts response was not a JSON object');
    }

    await updateSessionFacts({
      session_id,
      user_id,
      facts,
      source: 'llm',
      model: factsModel
    });

    logger.info('Session facts updated', {
      session_id,
      toolId,
      factsCount: Object.keys(facts).length,
      llmDurationMs: llmDuration,
      totalDurationMs: Date.now() - startTime
    });

    return { skipped: false, facts };
  } catch (error) {
    logger.error('Session facts generation failed', {
      session_id,
      toolId,
      error: error.message,
      stack: error.stack
    });
    if (error instanceof LLMServiceError) throw error;
    throw new LLMServiceError('Failed to generate session facts', error);
  }
}

module.exports = {
  generateSessionFactsUpdate
};

