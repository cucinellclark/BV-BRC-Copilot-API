// test-mcp2.js
// Minimal test script for talking to a FastMCP server
// Works with Node 18+ (has fetch built-in)

const { v4: uuidv4 } = require('uuid');

const FASTMCP_URL = process.env.FASTMCP_URL || 'http://127.0.0.1:8059/mcp';
const SESSION_ID = uuidv4();
const SESSION_HEADER = 'X-Session-Id';

console.log('Using FastMCP URL:', FASTMCP_URL);
console.log('Session ID:', SESSION_ID);

// --- 1. Open SSE stream ---
async function openStream() {
  console.log('\n--- Opening SSE stream ---\n');
  const res = await fetch(FASTMCP_URL, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      [SESSION_HEADER]: SESSION_ID,
    },
  });

  if (!res.ok || !res.body) {
    console.error('Failed to open SSE stream:', res.status, res.statusText);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let chunks = '';
  for (let i = 0; i < 3; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks += decoder.decode(value, { stream: true });
  }

  console.log('Received SSE data:\n', chunks);
  reader.cancel();
}

// --- 2. Send JSON-RPC request ---
async function listTools() {
  console.log('\n--- Sending JSON-RPC: tools/list ---\n');

  const payload = {
    jsonrpc: '2.0',
    id: '1',
    method: 'tools/list',
    params: {},
  };

  const res = await fetch(FASTMCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [SESSION_HEADER]: SESSION_ID,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('Response headers:', res.headers.get('content-type'));
  console.log('Response body:\n', text);
}

(async () => {
  await openStream();
  await listTools();
})();
