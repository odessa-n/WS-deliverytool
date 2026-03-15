# Merge FrameworkMappingDB and TestFrameworkDB

## Goal

Merge the two modules into a single file, **FrameworkMappingDB.js**, using FrameworkMappingDB as the base (more current code). One sheet, one column layout:

**Unified sheet (tab: `FrameworkMappingDB`):**

| id | name | type | category | updatedAt | &lt;framework columns&gt; |
|----|------|------|----------|-----------|---------------------------|

- **Fixed columns:** `id`, `name`, `type`, `category`, `updatedAt`
- **Dynamic columns:** One per framework (e.g. SOC 2, ISO 27001, HIPAA). Cell = framework name when mapped, em dash (—) when not.
- **type values:** `Automated Test` | `Document` (singular; canonical in this sheet)

---

## Current state

| Aspect | FrameworkMappingDB | TestFrameworkDB |
|--------|--------------------|-----------------|
| **Sheet name** | `FrameworkMappingDB` | `TestFrameworkDB` |
| **Fixed cols** | id, name, type, category, updatedAt | Same |
| **Document type** | `Document` | `Documents` |
| **Public API** | `WD_syncFrameworkMappingDB`, `WD_getFrameworkMappingDB` | `TFW_upsertMaps_`, `TFW_buildScopingMaps_`, `TFW_updateSheetScoping_` |
| **Called from** | Control Mapping UI (Scripts.html) | TestMonitor.js only |
| **Entry point** | Full Vanta traversal (sync) | Upsert from in-memory maps (Phase 2) |
| **Framework sort** | Priority list (SOC 2, ISO 27001, …) then alpha | Alphabetical |

---

## Design decisions

1. **Single sheet name:** `FrameworkMappingDB` (drop `TestFrameworkDB`).
2. **Canonical type for documents:** `Document` (singular) in the central sheet. The per-client TM: sheets keep using `Documents` in their `type` column; only the central DB uses `Document`.
3. **Naming:** Prefer `FMDB_*` for all internal and TestMonitor-facing helpers. Rename TFW’s public helpers to `FMDB_*` and update TestMonitor to call them.
4. **Backward compatibility when reading:** In `FMDB_buildScopingMaps_`, treat both `Document` and `Documents` as document rows so any legacy or migrated data still counts as docs.

---

## Implementation steps

### 1. Add TestFrameworkDB logic into FrameworkMappingDB.js

Keep existing FMDB code as-is. Add the following, implemented to use the single sheet and `FMDB_*` naming.

- **`FMDB_upsertFromMaps_(testFrameworkMap, docFrameworkMap, testNameMap, docNameMap, clientSheet)`**  
  - Port of `TFW_upsertMaps_`: build `byId` from the four maps and optional `clientSheet`.  
  - Use type **`Document`** (not `Documents`) when adding doc entries.  
  - Call existing `FMDB_batchUpsert_(sheet, byId)` and `FMDB_getOrCreateSheet_()`.  
  - Reuse the same “skip if no name” and logging behavior as TFW.

- **`FMDB_readIdMeta_(clientSheet)`**  
  - Port of `TFW_readIdMeta_`: returns `{ id: { name, type, category } }` from a TM: client sheet.  
  - Used by `FMDB_upsertFromMaps_` to resolve names/category for IDs.

- **`FMDB_buildScopingMaps_(clientFrameworks)`**  
  - Port of `TFW_buildScopingMaps_`: read the **FrameworkMappingDB** sheet, filter by `clientFrameworks`, return  
    `{ testsById, docsById, testsByName, docsByName }`.  
  - When classifying rows, treat **type === `Document` or type === `Documents`** as document (for backward compat).  
  - Use existing `FMDB_FIXED_LEAD`, `FMDB_FIXED_TRAIL`, `FMDB_DASH` and header parsing.

- **`FMDB_updateSheetScoping_(sheet, maps)`**  
  - Port of `TFW_updateSheetScoping_`: given a TM: ClientName sheet and `maps` from `FMDB_buildScopingMaps_`, update `framework` and `Scoped` columns (ID-first, then name fallback).  
  - No change to TM: sheet structure; it still uses `Documents` in the type column.  
  - Signature and behavior identical to current `TFW_updateSheetScoping_`.

Use the same column layout and key strategy as existing FMDB: key = `id|type` (and name fallback). Ensure `FMDB_batchUpsert_` and header order stay as they are (fixed lead + framework cols + fixed trail).

### 2. Update TestMonitor.js

- Replace every `TFW_upsertMaps_(...)` with **`FMDB_upsertFromMaps_(...)`**.
- Replace every `TFW_buildScopingMaps_(...)` with **`FMDB_buildScopingMaps_(...)`**.
- Replace every `TFW_updateSheetScoping_(...)` with **`FMDB_updateSheetScoping_(...)`**.

No changes to TM: sheet column names or type value `Documents`; only the central DB and the names of the functions called from TestMonitor change.

### 3. Remove TestFrameworkDB.js

- Delete **TestFrameworkDB.js**.
- Remove any references to `TFW_*` or `TestFrameworkDB` from the codebase (grep to confirm only TestMonitor needed updates).

### 4. Optional: one-time migration of existing TestFrameworkDB sheet

If some deployments already have a **TestFrameworkDB** sheet and you want to avoid duplicate data:

- Add a one-time function (e.g. `FMDB_migrateFromTestFrameworkDB_()`) that:  
  - Opens CLIENT_DB, gets sheet `TestFrameworkDB` (if present).  
  - Reads all rows, normalizes `type`: replace `Documents` with `Document`.  
  - Upserts into the FrameworkMappingDB sheet (via the same byId shape and `FMDB_batchUpsert_` or a single batch append).  
  - Optionally rename or delete the old TestFrameworkDB sheet after success.  
- Run once per deployment (e.g. from the Apps Script editor or a menu), then remove or leave as a no-op if sheet missing.

If you do **not** need to preserve existing TestFrameworkDB data, skip this step and let the next Phase 2 / sync repopulate the single sheet.

### 5. Tests and docs

- **TEST_FMDB_Inspect** (existing): still works; it only reads the single sheet.  
- Remove or repurpose **TEST_TFW_Inspect** and **TEST_TFW_ForceRebuildAndUpsert** (TestMonitor.js): either point them at `FMDB_*` and rename to e.g. `TEST_FMDB_ScopingInspect`, or document that Test Monitor Phase 2 and “Rebuild” now use FrameworkMappingDB.  
- Update **DEBUG_STEPS.md** or any doc that mentions TestFrameworkDB to say the central registry is FrameworkMappingDB (one sheet, one file).

---

## Summary

- **One file:** FrameworkMappingDB.js.  
- **One sheet:** FrameworkMappingDB, columns `id | name | type | category | updatedAt | <framework columns>`.  
- **One canonical document type in that sheet:** `Document`.  
- **TestMonitor** calls `FMDB_upsertFromMaps_`, `FMDB_buildScopingMaps_`, `FMDB_updateSheetScoping_` instead of TFW_* and uses the same sheet.  
- **TestFrameworkDB.js** is removed after the merge and call-site updates.
