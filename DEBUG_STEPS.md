# Debug & Test Steps

## Test Monitor editor-run tests

Test Monitor provides test helpers in **TestMonitor.js** (e.g. `TEST_TM_Phase1`, `TEST_TM_Phase2`, `TEST_TFW_ForceRebuildAndUpsert`, `TEST_TM_DiagnoseFrameworks`) that are intended to be run from the Apps Script editor (Run menu).

These functions use a hardcoded **`TEST_CLIENT_NAME`** (default: `'Tenex'`) near the bottom of TestMonitor.js. If your target environment does not have a client named "Tenex", either:

1. **Change the constant** in TestMonitor.js to a valid client name in your Client DB, or  
2. **Add a client** with that name to your Client DB sheet.

Otherwise, editor-run tests will fail with "no sheet" or token/client lookup errors.

## Smoke test after deployment

1. Load the web app and confirm the sidebar and all modules render (Dashboard, Trust Ops, Test Monitoring, Client Management, Framework Mapping, Drive Utility, Vendor Risk).
2. Click **Refresh Clients** once and verify the client dropdown(s) fill in all modules that show a client selector (Trust Ops, Framework Mapping, Vendor Risk). Confirm only one network round-trip for clients (check browser Network tab if possible).
3. Select a client and run a short flow in Trust Ops (Generate from Vanta) and in Test Monitoring (Refresh Selected). Confirm token cache reduces repeated token calls when multiple operations use the same client.
4. In Control Mapping, select client + framework and load; use "Refresh" to confirm cache vs live behavior.
5. Trigger an error (e.g. disconnect network or use an invalid client) and confirm each module shows a clear user-visible error message (not only console).

## Scheduling (optional)

To keep Test Monitor data fresh without running the UI each day:

1. In the Apps Script editor, add a time-based trigger: **Edit > Current project's triggers > Add Trigger**. Choose a function (e.g. a wrapper that loops over clients and calls `TM_refreshClientData` for each, with time-boxing to avoid the 6-minute limit), set "Time-driven", and pick a time (e.g. daily at 2am).
2. Ensure the trigger runs as the same user who has access to the Client DB spreadsheet and token service.
3. For a full sync (Refresh All + Update Framework Scoping), you can implement a server-only function that processes clients in batches and persists progress; document it in `workflows/` if you add it.
