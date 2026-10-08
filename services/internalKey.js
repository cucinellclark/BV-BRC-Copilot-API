// services/internalKey.js
//
// Shared secret the gateway sends to the Python orchestrator in the
// X-Copilot-Internal-Key header. The orchestrator rejects every request
// except GET /health without it (see bvbrc-agents
// orchestrator/orchestrator/internal_auth.py).
//
// Source, first match wins:
//   1. COPILOT_INTERNAL_KEY env var
//   2. the file named by COPILOT_INTERNAL_KEY_FILE,
//      or config.orchestrator.internal_key_file,
//      or ~/.copilot_internal_key
//
// Read once and cached. A missing key is logged, not fatal: the
// orchestrator answers 401 and the turn fails with a visible error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config.json');

const INTERNAL_KEY_HEADER = 'X-Copilot-Internal-Key';

let cachedKey;

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadInternalKey() {
  const fromEnv = (process.env.COPILOT_INTERNAL_KEY || '').trim();
  if (fromEnv) return fromEnv;

  const keyFile = expandHome(
    process.env.COPILOT_INTERNAL_KEY_FILE ||
    config.orchestrator?.internal_key_file ||
    '~/.copilot_internal_key'
  );
  try {
    return fs.readFileSync(keyFile, 'utf8').trim() || null;
  } catch (err) {
    console.error(`[internalKey] No orchestrator internal key at ${keyFile} ` +
      `(${err.code || err.message}); orchestrator calls will be rejected with 401.`);
    return null;
  }
}

function getInternalKey() {
  if (cachedKey === undefined) cachedKey = loadInternalKey();
  return cachedKey;
}

/** Headers to merge into every request to the orchestrator. */
function internalKeyHeaders() {
  const key = getInternalKey();
  return key ? { [INTERNAL_KEY_HEADER]: key } : {};
}

module.exports = { INTERNAL_KEY_HEADER, internalKeyHeaders, getInternalKey };
