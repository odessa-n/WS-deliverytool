# Framework Mapping Sync

## Objective
Maintain the central Framework Mapping DB sheet (id, name, type, category, framework columns) so Test Monitor and other tools can scope items by framework.

## Inputs
- Client list (for “Fetch for all clients”)
- Per-client Vanta frameworks (from API)

## Steps
1. **Load Map** (single client + framework): Loads controls/tests/documents for the selected framework and syncs that framework into the central DB. Use for one-off updates.
2. **Fetch for all clients**: Syncs all frameworks for every client into the central DB. Admin only. Run periodically to keep the table current.
3. Table shows **Last updated**. Open Framework Mapping module to load table and see timestamp.

## Edge cases
- Admin required for Fetch for all clients; set ADMIN_EMAILS in Script Properties.
- Long run: progress not per-client; wait for completion or check logs.
