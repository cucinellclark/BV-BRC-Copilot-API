const { connectToDatabase } = require('../database');

function toCanonicalCall(raw, fallback, seed) {
  if (!raw || typeof raw !== 'object') return null;
  const action = raw.action || raw.tool || raw.tool_id || fallback || null;
  if (!action) return null;
  return {
    id: `${seed}:${action}`,
    run_id: null,
    iteration: null,
    action,
    sequence: 1,
    arguments: (raw.arguments && typeof raw.arguments === 'object') ? raw.arguments : (raw.arguments_executed || {}),
    replay: {
      replayable: raw.replayable === true,
      ...(raw.rql_replay && typeof raw.rql_replay === 'object' ? { rql_replay: raw.rql_replay } : {})
    },
    status: 'success',
    result_ref: { type: 'unknown' }
  };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await connectToDatabase();
  const sessions = db.collection('chat_sessions');
  const cursor = sessions.find({}, { projection: { session_id: 1, messages: 1 } });

  let updatedSessions = 0;
  while (await cursor.hasNext()) {
    const session = await cursor.next();
    const messages = Array.isArray(session.messages) ? session.messages : [];
    let mutated = false;
    const nextMessages = messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const updated = { ...message };
      const canonicalCalls = [];
      const messageSeed = `${session.session_id || 'session'}:${updated.message_id || 'message'}`;

      if (Array.isArray(updated.ui_tool_calls)) {
        updated.ui_tool_calls.forEach((entry, idx) => {
          const canonical = toCanonicalCall(
            entry.tool_call,
            entry.source_tool,
            `${messageSeed}:${idx + 1}`
          );
          if (canonical) canonicalCalls.push(canonical);
        });
      }
      if (canonicalCalls.length === 0 && updated.ui_active_tool_call && typeof updated.ui_active_tool_call === 'object') {
        const canonical = toCanonicalCall(
          updated.ui_active_tool_call,
          updated.ui_source_tool || updated.source_tool || null,
          `${messageSeed}:active`
        );
        if (canonical) canonicalCalls.push(canonical);
      }

      if (canonicalCalls.length > 0) {
        updated.tool_calls = canonicalCalls;
        updated.active_tool_call_id = canonicalCalls[canonicalCalls.length - 1].id;
        mutated = true;
      }

      if (
        Object.prototype.hasOwnProperty.call(updated, 'ui_tool_calls') ||
        Object.prototype.hasOwnProperty.call(updated, 'ui_active_tool_call') ||
        Object.prototype.hasOwnProperty.call(updated, 'ui_preferred_tools') ||
        Object.prototype.hasOwnProperty.call(updated, 'ui_source_tool')
      ) {
        delete updated.ui_tool_calls;
        delete updated.ui_active_tool_call;
        delete updated.ui_preferred_tools;
        delete updated.ui_source_tool;
        mutated = true;
      }
      return updated;
    });

    if (!mutated) continue;
    updatedSessions += 1;
    if (!dryRun) {
      await sessions.updateOne(
        { _id: session._id },
        {
          $set: {
            messages: nextMessages,
            tool_tracking_schema_version: 2,
            last_modified: new Date()
          }
        }
      );
    }
  }

  console.log(JSON.stringify({ dryRun, updatedSessions }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
