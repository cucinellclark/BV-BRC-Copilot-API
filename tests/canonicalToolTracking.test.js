const assert = require('assert');
const { normalizeCanonicalToolTrackingMessage } = require('../services/dbUtils');
const { McpStreamHandler } = require('../services/mcp/mcpStreamHandler');

function testNormalizeCanonicalMessage() {
  const message = {
    role: 'assistant',
    ui_tool_calls: [{ bad: true }],
    ui_active_tool_call: { bad: true },
    ui_preferred_tools: ['a'],
    ui_source_tool: 'a',
    tool_calls: [
      { id: 'c1', action: 'a', arguments: {} },
      { id: 'c1', action: 'a', arguments: {} },
      { id: 'c2', action: 'b', arguments: {} }
    ]
  };
  const normalized = normalizeCanonicalToolTrackingMessage(message);
  assert.strictEqual(Array.isArray(normalized.tool_calls), true);
  assert.strictEqual(normalized.tool_calls.length, 2);
  assert.strictEqual(normalized.active_tool_call_id, 'c2');
  assert.strictEqual(normalized.ui_tool_calls, undefined);
  assert.strictEqual(normalized.ui_active_tool_call, undefined);
}

function testMergeBatchesDedup() {
  const handler = new McpStreamHandler(null);
  const batchRecord = JSON.stringify([JSON.stringify({ results: [{ genome_id: 'g1' }, { genome_id: 'g2' }] })]);
  const dupRecord = JSON.stringify([JSON.stringify({ results: [{ genome_id: 'g2' }, { genome_id: 'g3' }] })]);
  const batches = [
    { content: [{ text: batchRecord }], numFound: 3 },
    { content: [{ text: dupRecord }], numFound: 3 }
  ];
  const merged = handler.mergeBatches(batches, 2, 10, { info: () => {} });
  assert.strictEqual(merged.results.length, 3);
  assert.strictEqual(merged._duplicateResultsDropped, 1);
}

testNormalizeCanonicalMessage();
testMergeBatchesDedup();
console.log('canonicalToolTracking.test.js passed');
