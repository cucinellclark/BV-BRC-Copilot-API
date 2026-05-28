/**
 * MongoDB Migration Script: Add msg.workflow nested object to legacy messages
 *
 * Scans all chat_sessions for messages with legacy flat workflow fields
 * (isWorkflow, workflow_id, workflowData) and adds a `workflow` nested object.
 *
 * Usage:
 *   mongo <database_name> migrate_workflow_messages.js
 *
 * Or with connection string:
 *   mongosh "mongodb://host:port/dbname" migrate_workflow_messages.js
 *
 * This script is idempotent — it only adds msg.workflow where it doesn't
 * already exist.
 *
 * After verifying the migration, a follow-up pass can optionally strip
 * the legacy fields (isWorkflow, workflow_id, workflowData) from messages.
 */

// ---- Configuration ----
var DRY_RUN = false; // Set to true to preview changes without writing
var COLLECTION_NAME = 'chat_sessions';

// ---- Migration ----
var totalSessions = 0;
var updatedSessions = 0;
var migratedMessages = 0;
var skippedMessages = 0;

print('=== Workflow Message Migration ===');
print('Mode: ' + (DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'));
print('Collection: ' + COLLECTION_NAME);
print('');

db.getCollection(COLLECTION_NAME).find({
  'messages.isWorkflow': true
}).forEach(function(session) {
  totalSessions++;
  var needsUpdate = false;

  if (!Array.isArray(session.messages)) {
    return;
  }

  session.messages.forEach(function(msg, i) {
    // Only migrate messages that have legacy workflow fields but no new workflow object
    if (msg.isWorkflow && msg.workflow_id && !msg.workflow) {
      var status = 'planned';
      if (msg.workflowData && msg.workflowData.execution_metadata &&
          msg.workflowData.execution_metadata.status) {
        status = msg.workflowData.execution_metadata.status;
      } else if (msg.workflowData && msg.workflowData.status) {
        status = msg.workflowData.status;
      }

      var workflowName = null;
      if (msg.workflowData && msg.workflowData.workflow_name) {
        workflowName = msg.workflowData.workflow_name;
      }

      var stepCount = null;
      if (msg.workflowData && msg.workflowData.steps &&
          Array.isArray(msg.workflowData.steps)) {
        stepCount = msg.workflowData.steps.length;
      }

      msg.workflow = {
        workflow_id: msg.workflow_id,
        status: status,
        persisted: true,
        workflow_name: workflowName,
        step_count: stepCount
      };

      needsUpdate = true;
      migratedMessages++;

      if (DRY_RUN) {
        print('  [DRY RUN] Would migrate message ' + i + ' in session ' +
              session._id + ' (workflow_id: ' + msg.workflow_id + ')');
      }
    } else if (msg.isWorkflow && !msg.workflow_id && !msg.workflow) {
      // Has isWorkflow but no workflow_id — try to extract from workflowData
      var extractedId = null;
      if (msg.workflowData && msg.workflowData.workflow_id) {
        extractedId = msg.workflowData.workflow_id;
      } else if (msg.workflowData && msg.workflowData.execution_metadata &&
                 msg.workflowData.execution_metadata.workflow_id) {
        extractedId = msg.workflowData.execution_metadata.workflow_id;
      }

      if (extractedId) {
        var extractedStatus = 'planned';
        if (msg.workflowData && msg.workflowData.execution_metadata &&
            msg.workflowData.execution_metadata.status) {
          extractedStatus = msg.workflowData.execution_metadata.status;
        } else if (msg.workflowData && msg.workflowData.status) {
          extractedStatus = msg.workflowData.status;
        }

        msg.workflow = {
          workflow_id: extractedId,
          status: extractedStatus,
          persisted: true,
          workflow_name: (msg.workflowData && msg.workflowData.workflow_name) || null,
          step_count: (msg.workflowData && msg.workflowData.steps &&
                       Array.isArray(msg.workflowData.steps))
                      ? msg.workflowData.steps.length : null
        };

        needsUpdate = true;
        migratedMessages++;

        if (DRY_RUN) {
          print('  [DRY RUN] Would migrate message ' + i + ' in session ' +
                session._id + ' (extracted workflow_id: ' + extractedId + ')');
        }
      } else {
        skippedMessages++;
        if (DRY_RUN) {
          print('  [SKIP] Message ' + i + ' in session ' + session._id +
                ' has isWorkflow=true but no workflow_id found');
        }
      }
    } else if (msg.workflow) {
      // Already has workflow object — skip
      skippedMessages++;
    }
  });

  if (needsUpdate && !DRY_RUN) {
    db.getCollection(COLLECTION_NAME).updateOne(
      { _id: session._id },
      { $set: { messages: session.messages } }
    );
    updatedSessions++;
  } else if (needsUpdate) {
    updatedSessions++;
  }
});

print('');
print('=== Migration Summary ===');
print('Sessions scanned:  ' + totalSessions);
print('Sessions updated:  ' + updatedSessions);
print('Messages migrated: ' + migratedMessages);
print('Messages skipped:  ' + skippedMessages);

if (DRY_RUN) {
  print('');
  print('This was a DRY RUN. Set DRY_RUN = false and re-run to apply changes.');
}
