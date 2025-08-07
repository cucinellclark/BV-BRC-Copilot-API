// services/jsonUtils.js

/**
 * Attempt to parse a model response that is expected to be JSON but may be
 * wrapped in markdown fences or contain extra prefix/suffix content.  If parsing
 * fails the function returns null instead of throwing.
 *
 * @param {string} text – raw text returned by the model
 * @returns {object|null}
 */
function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;

  // Remove ```json ``` or ``` fences that LLM responses often include
  const cleaned = text
    .replace(/```json[\s\S]*?```/gi, (m) => m.replace(/```json|```/gi, ''))
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Fallback: try to extract the first {...} block in the string
    const first = cleaned.indexOf('{');
    const last  = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

module.exports = {
  safeParseJson
}; 