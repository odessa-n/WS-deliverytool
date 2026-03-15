# Test Monitor Refresh and Scoping

## Objective
Keep the Test Monitor summary table and per-client sheets up to date with Vanta data and framework scoping.

## Inputs
- Client list (from Central API / token service)
- Framework Mapping DB (central sheet) for name-based scoping

## Steps
1. **Refresh All from Vanta** (Wave 1): Fetches tests and documents for each client, writes TM: ClientName sheets, updates summary. Run this to pull latest from Vanta.
2. **Update Framework Scoping** (Wave 2): Rebuilds TMCache and FrameworkMappingDB maps, re-applies framework/scoped columns to TM sheets. Run after Refresh if you added clients or changed frameworks.
3. Use **Refresh Selected** for checked clients only (Wave 1). Use per-row ↻ to refresh one client.

## Edge cases
- First run or new client: run Refresh first, then Update Framework Scoping so central DB has data.
- 6-minute limit: for many clients, run in batches (e.g. Refresh Selected in chunks) or use scheduled trigger (see scheduling doc).
