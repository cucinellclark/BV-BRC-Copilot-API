const { connectToDatabase } = require('../../database');
const config = require('../../config.json');

const COLLECTION = 'session_memory';
const MAX_FACT_KEYS = 200;
const MAX_EXTRACTED_FACTS = 25;

function defaultSessionMemory(session_id, user_id) {
  return {
    session_id,
    user_id,
    focus: null,
    facts: {},
    tool_facts: {},
    entities: {},
    last_tool: null,
    updated_at: new Date().toISOString()
  };
}

async function getSessionMemory(session_id, user_id = null) {
  if (!session_id) return defaultSessionMemory(null, user_id);
  const db = await connectToDatabase();
  const doc = await db.collection(COLLECTION).findOne({ session_id });
  if (!doc) return defaultSessionMemory(session_id, user_id);
  return {
    ...defaultSessionMemory(session_id, user_id),
    ...doc
  };
}

async function saveSessionMemory(session_id, user_id, memory) {
  if (!session_id) return memory;
  const db = await connectToDatabase();
  const updateDoc = {
    ...memory,
    session_id,
    user_id,
    updated_at: new Date().toISOString()
  };
  await db.collection(COLLECTION).updateOne(
    { session_id },
    { $set: updateDoc },
    { upsert: true }
  );
  return updateDoc;
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function shouldStorePrimitive(value) {
  if (!isPrimitive(value)) return false;
  if (typeof value === 'string' && value.length > 200) return false;
  return true;
}

function parseJsonIfPossible(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractFactsFromObject(obj, maxFacts = MAX_EXTRACTED_FACTS, maxDepth = 2) {
  const facts = {};
  const queue = [{ value: obj, path: '', depth: 0 }];

  while (queue.length > 0 && Object.keys(facts).length < maxFacts) {
    const { value, path, depth } = queue.shift();

    if (isPrimitive(value)) {
      if (shouldStorePrimitive(value) && path) {
        facts[path] = value;
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && depth < maxDepth) {
        const first = value[0];
        if (isPrimitive(first)) {
          if (shouldStorePrimitive(first) && path) {
            facts[path] = first;
          }
        } else {
          queue.push({ value: first, path: `${path}[0]`, depth: depth + 1 });
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && depth < maxDepth) {
      for (const [key, nested] of Object.entries(value)) {
        if (Object.keys(facts).length >= maxFacts) break;
        const nextPath = path ? `${path}.${key}` : key;
        if (isPrimitive(nested)) {
          if (shouldStorePrimitive(nested)) {
            facts[nextPath] = nested;
          }
        } else {
          queue.push({ value: nested, path: nextPath, depth: depth + 1 });
        }
      }
    }
  }

  return facts;
}

function mergeFacts(existing, next, maxKeys = MAX_FACT_KEYS) {
  const merged = { ...existing, ...next };
  const keys = Object.keys(merged);
  if (keys.length <= maxKeys) return merged;
  const nextKeys = new Set(Object.keys(next));
  const trimmed = {};
  for (const key of keys) {
    if (nextKeys.has(key)) trimmed[key] = merged[key];
  }
  for (const key of keys) {
    if (Object.keys(trimmed).length >= maxKeys) break;
    if (!nextKeys.has(key)) trimmed[key] = merged[key];
  }
  return trimmed;
}

function pickFocusFromFacts(facts) {
  const keys = Object.keys(facts);
  if (keys.length === 0) return null;
  const priority = ['genome_id', 'sample_id', 'sra_id', 'taxon_id', 'workspace_path', 'task_id', 'workflow_id', 'id'];
  for (const key of priority) {
    if (facts[key] !== undefined) {
      return { type: 'fact', key, value: facts[key] };
    }
  }
  const fallbackKey = keys.find((k) => k.endsWith('_id') || k === 'id');
  if (fallbackKey) {
    return { type: 'fact', key: fallbackKey, value: facts[fallbackKey] };
  }
  return null;
}

function extractFactsFromResult(result) {
  if (result == null) return {};
  if (Array.isArray(result)) {
    if (result.length === 0) return {};
    const first = result[0];
    if (typeof first === 'object' && first !== null) {
      return extractFactsFromObject(first);
    }
    return {};
  }
  if (typeof result === 'object') {
    return extractFactsFromObject(result);
  }
  return {};
}

async function updateSessionMemory({ session_id, user_id, toolId, parameters, result }) {
  if (!session_id) return null;
  const memory = await getSessionMemory(session_id, user_id);
  const nextMemory = { ...memory };

  nextMemory.last_tool = {
    tool: toolId,
    parameters: parameters || {},
    timestamp: new Date().toISOString()
  };

  let extractedFacts = {};

  if (result && result.type === 'file_reference') {
    const fileId = result.file_id;
    nextMemory.entities = nextMemory.entities || {};
    if (fileId) {
      nextMemory.entities[fileId] = {
        type: 'file',
        tool: toolId,
        summary: result.summary,
        created_at: new Date().toISOString()
      };
      nextMemory.focus = { type: 'file', file_id: fileId, tool: toolId };
    }

    const sample = parseJsonIfPossible(result.summary?.sampleRecord);
    if (sample && typeof sample === 'object') {
      extractedFacts = extractFactsFromObject(sample);
    } else if (shouldStorePrimitive(sample)) {
      extractedFacts = { sample_record: sample };
    }

    const summaryFacts = {};
    if (result.summary?.dataType) summaryFacts.data_type = result.summary.dataType;
    if (typeof result.summary?.recordCount === 'number') summaryFacts.record_count = result.summary.recordCount;
    if (Array.isArray(result.summary?.fields)) summaryFacts.fields = result.summary.fields.slice(0, 25);
    extractedFacts = { ...summaryFacts, ...extractedFacts };
  } else {
    extractedFacts = extractFactsFromResult(result);
    const focusFromFacts = pickFocusFromFacts(extractedFacts);
    if (focusFromFacts) {
      nextMemory.focus = focusFromFacts;
    }
  }

  nextMemory.tool_facts = nextMemory.tool_facts || {};
  if (toolId) {
    nextMemory.tool_facts[toolId] = extractedFacts;
  }
  
  // LLM facts are authoritative; do not merge tool-derived facts into facts.
  nextMemory.updated_at = new Date().toISOString();

  return await saveSessionMemory(session_id, user_id, nextMemory);
}

async function updateSessionFacts({ session_id, user_id, facts, source = 'llm', model = null }) {
  if (!session_id) return null;
  const memory = await getSessionMemory(session_id, user_id);
  const nextMemory = { ...memory };

  nextMemory.facts = facts && typeof facts === 'object' ? facts : {};
  nextMemory.facts_meta = {
    source,
    model,
    updated_at: new Date().toISOString()
  };
  nextMemory.updated_at = new Date().toISOString();

  return await saveSessionMemory(session_id, user_id, nextMemory);
}

function formatSessionMemory(memory) {
  if (!memory) return 'No session memory available';
  const focus = memory.focus ? JSON.stringify(memory.focus, null, 2) : 'null';
  const facts = memory.facts && Object.keys(memory.facts).length > 0
    ? JSON.stringify(memory.facts, null, 2)
    : '{}';
  
  let output = `FOCUS:\n${focus}\n\nFACTS:\n${facts}`;
  
  return output;
}

module.exports = {
  getSessionMemory,
  updateSessionMemory,
  updateSessionFacts,
  formatSessionMemory
};

