// services/queryEnhancement.js

const { getModelData } = require('../core/dbUtils');
const { queryChatOnly, queryChatImage } = require('../../llm/llmServices');

/**
 * Enhance a user query by injecting relevant context from the system prompt or image.
 * The function uses an LLM to rewrite the query so that downstream models receive
 * a richer prompt while keeping the original intent intact. The LLM is instructed
 * to return ONLY the rewritten query text with no additional commentary.
 *
 * @param {string} originalQuery  - The user's original query.
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
    const enhancementInstruction =
      'You are an assistant that rewrites the user\'s query by augmenting it with any RELEVANT context provided.' +
      ' The rewritten query must preserve the original intent while adding helpful detail.' +
      ' If the additional context is not relevant, keep the query unchanged.' +
      ' Respond ONLY with the rewritten query and nothing else.';

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
        system_prompt: enhancementInstruction + (systemPrompt ? `\n\nTextual context you may use if relevant:\n${systemPrompt}` : '')
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

module.exports = {
  enhanceQuery
}; 