# Canonical Tool Tracking Cutover Checklist

## Pre-Cutover
- Announce read-only maintenance window.
- Run `node scripts/migrateCanonicalToolCalls.js --dry-run`.
- Verify dry-run `updatedSessions` looks reasonable.

## Cutover
- Stop write traffic to chat endpoints.
- Run `node scripts/migrateCanonicalToolCalls.js`.
- Deploy API and MCP server changes in this release.
- Restart services.

## Post-Cutover Validation
- Run `node tests/canonicalToolTracking.test.js`.
- Execute one streaming session and verify each `tool_executed` event includes `tool_call`.
- Reload the same session and verify only `tool_calls` + `active_tool_call_id` are present.
- Confirm no `ui_tool_calls`/`ui_active_tool_call` fields in newly persisted assistant messages.

## Rollback
- Restore database backup from pre-cutover snapshot.
- Roll back API/MCP server deploy together.
