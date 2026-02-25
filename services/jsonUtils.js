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
  let cleaned = text
    .replace(/```json[\s\S]*?```/gi, (m) => m.replace(/```json|```/gi, ''))
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .trim();

  // Remove JavaScript-style comments that some LLMs add
  // Remove single-line comments (// comment)
  cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
  // Remove multi-line comments (/* comment */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  // Clean up any trailing commas before closing braces/brackets
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  // Normalize JS token 'undefined' to JSON null when it appears as a bare value.
  // This is a pragmatic guard for planner responses that are almost-valid JSON.
  cleaned = replaceBareUndefinedWithNull(cleaned);

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

function replaceBareUndefinedWithNull(input) {
  if (!input || typeof input !== 'string') return input;
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (input.startsWith('undefined', i)) {
      const prev = i === 0 ? '' : input[i - 1];
      const next = i + 9 >= input.length ? '' : input[i + 9];
      const prevIsWord = /[A-Za-z0-9_$]/.test(prev);
      const nextIsWord = /[A-Za-z0-9_$]/.test(next);
      if (!prevIsWord && !nextIsWord) {
        out += 'null';
        i += 9;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

module.exports = {
  safeParseJson
}; 