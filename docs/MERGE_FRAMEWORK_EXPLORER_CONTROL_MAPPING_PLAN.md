# Merge Framework Explorer and Control Mapping

## Goal

Merge the two modules into a single **Framework Explorer** module that:

- Uses **one** client selector and **one** framework selector.
- Shows **both tests and documents** for every control (already correct in Framework Explorer’s third column and in Control Mapping’s expandable rows).
- Supports both **drill-down** (framework → control → tests & documents) and **full-map** (load entire framework with cache + optional DB sync) in one place.

---

## Current state

| Aspect | Framework Explorer | Control Mapping |
|--------|--------------------|-----------------|
| **Nav** | Framework Explorer | Control Mapping |
| **Client** | `fxClientSelect` | `fdmClientSelect` |
| **Frameworks** | "Load Frameworks" → list (click to select) | Auto-load into `fdmFrameworkSelect` dropdown |
| **Controls** | Load on framework click → list (click to select) | Not listed separately; part of "full map" |
| **Tests & docs** | Load on control click via `WD_getControlDetails` (one control at a time) | Load all via `WD_getFrameworkDocMap` (cached), expandable rows |
| **API** | `WD_getFrameworks`, `WD_getFrameworkControls`, `WD_getControlDetails` | `WD_getFrameworks`, `WD_getFrameworkDocMap`, `WD_syncFrameworkMappingDB` |
| **Data** | Tests + documents per control (correct) | Tests + documents per control (correct; `WD_fetchFrameworkDocMapDirect_` in Copy fetches both) |

Both modules already show tests and documents; the difference is interaction (step-by-step vs full map + cache + sync).

---

## Backend: ensure full map returns tests and documents

Control Mapping uses `WD_getFrameworkDocMap` → `WD_fetchFrameworkDocMapDirect_(token, frameworkId)`.

- **Target currently:** `WD_fetchFrameworkDocMapDirect_` is **not** defined in `TokenandVanta.js` (only in Copy). It must be present for Control Mapping (and the merged module) to work.
- **Copy’s implementation** (TokenandVanta.js): Fetches all controls for the framework, then batch-fetches **documents** and **tests** per control (20 at a time), and returns:
  - `[{ id, name, category, description, documents: [...], tests: [...] }]`
- **Action:** Add `WD_fetchFrameworkDocMapDirect_` to the target’s **TokenandVanta.js** (copy from Copy’s TokenandVanta.js) so the full-map API returns both tests and documents. No change to the response shape is needed.

---

## Merged module design

**Single nav item:** e.g. **"Framework Explorer"** (subtitle: “Browse frameworks, controls, tests & documents; sync to FrameworkMappingDB.”).

**Single pane:**

1. **Top bar (shared)**
   - **Client** dropdown (reuse one selector: e.g. `fxClientSelect`; remove `fdmClientSelect`).
   - **Framework** dropdown: auto-filled when client is selected (same as current Control Mapping), or keep “Load Frameworks” and use a dropdown for framework choice so one list serves both flows.
   - **Primary actions:**
     - **“Load frameworks”** (or “Load”): loads framework list and enables framework selection (Explorer path).
     - **“Load full map”**: for the selected framework, calls `WD_getFrameworkDocMap` (cached) and optionally `WD_syncFrameworkMappingDB`; shows the expandable “Controls, Tests & Documents” view and cache/sync status.

2. **Content area: two modes or one combined layout**
   - **Option A – Tabs / toggle**
     - **Explore:** Three columns — Frameworks | Controls | Tests & Documents (current FX). Click framework → load controls; click control → load tests & documents for that control (`WD_getControlDetails`).
     - **Full map:** Single view — expandable list of controls, each with Tests and Documents sections (current Control Mapping). Uses cached data when “Load full map” was used; shows “Cached” vs “Live” and optional “Force refresh”.
   - **Option B – Single view with two ways to load**
     - One three-column layout. Left: framework list. Middle: control list (loaded when a framework is selected via API or from full-map data). Right: tests & documents for the selected control.
     - “Load full map” populates frameworks + controls + (per-control tests/docs) in one go and stores in state; clicking a control in the middle column then only shows the right column from that state (no extra request). “Load frameworks” alone keeps the current step-by-step loading.

Recommendation: **Option A** — keep the two mental models explicit (Explore vs Full map) with a tab or toggle, and reuse the existing Explorer three-column UI and the existing Control Mapping expandable list UI.

---

## Implementation steps

### 1. Backend: add `WD_fetchFrameworkDocMapDirect_` to target

- In **TokenandVanta.js**, add the function from Copy’s TokenandVanta.js (lines ~277–368).
- It must:
  - Take `(token, frameworkId)`.
  - Fetch controls, then batch-fetch **documents** and **tests** per control (batch size 20).
  - Return `[{ id, name, category, description, documents: [...], tests: [...] }]` so both tests and documents are included.

### 2. Single module in bootstrap and nav

- In **DeliveryService.js** `WD_getBootstrapData()`, remove the separate “Control Mapping” module entry; keep a single entry, e.g.:
  - `{ id: 'framework-explorer', label: 'Framework Explorer', icon: 'layers' }`
  - (Optionally rename to “Frameworks & Controls” and use that id everywhere.)
- In **Index.html**, remove the standalone Control Mapping section; merge its UI into the Framework Explorer section (see below).

### 3. Index.html: one section

- Keep **one** section, e.g. `id="module-framework-explorer"`.
- **Top:** One client dropdown, one framework dropdown, and two buttons: **“Load”** (step-by-step) and **“Load full map”** (cached + optional sync). Optional: “Force refresh” checkbox and cache/sync status text.
- **Content:**
  - **Explore tab/view:** Three panels: Frameworks list | Controls list | Tests & Documents list (current FX markup and IDs: `fxFrameworksList`, `fxControlsList`, `fxDetailsList`).
  - **Full map tab/view:** One area with the expandable control rows (current FDM markup: `fdm-results`, `fdm-ctrl-row`, etc.). Ensure each control row shows both **Tests** and **Documents** sections (already in current `fdmRenderDocMap`).
- Remove the duplicate `module-control-mapping` section and any second client/framework dropdown that belonged only to Control Mapping.

### 4. Scripts.html: single state and shared selectors

- Use **one** client dropdown for both flows (e.g. `fxClientSelect`). In `renderClients()`, stop populating `fdmClientSelect` (remove it from the DOM or repurpose it as the single framework dropdown if you prefer).
- **State:** One `state.fx` (or similar) that holds:
  - `clientName`, `frameworks`, `selectedFrameworkId`, `controls`, `selectedControlId`
  - and for full-map: `fullMapData` (result of `WD_getFrameworkDocMap`), `fullMapFromCache`, `syncStatus`.
- **Frameworks:** On client change, call `WD_getFrameworks(client)` once and fill the single framework dropdown; use it for both “Load” (step-by-step) and “Load full map”.
- **Explore path:** Unchanged: “Load” or selecting a framework loads controls via `WD_getFrameworkControls`; clicking a control loads tests & docs via `WD_getControlDetails`. Render in the three-column panels; ensure **Tests** and **Documents** are both rendered (already the case in `fxRenderDetails`).
- **Full map path:** “Load full map” calls `WD_getFrameworkDocMap` and, in parallel or after, `WD_syncFrameworkMappingDB`. Store result in state and render the expandable list; ensure each control shows **tests** and **documents** (already in `fdmRenderDocMap`).
- **Cleanup:** Remove `fdmState`, `fdmOnClientChange`, `fdmOnFrameworkChange`, `fdmLoad`, `fdmRenderDocMap`, `fdmToggle`, `fdmSetResults`, `fdmReset` as separate entry points; fold their behavior into the single module’s handlers (e.g. “Full map” tab uses the same render function and same API calls). Remove or repurpose `fdmClientSelect`, `fdmFrameworkSelect`, `fdmLoadBtn`, etc., so only one set of client/framework controls exists.

### 5. Styles

- In **Styles.html**, keep or merge `.fx-*` and `.fdm-*` classes so the merged layout looks consistent. Prefer one set of panel/card styles (e.g. use `.fx-*` for both Explore and Full map content).

### 6. Client dropdown count

- **renderClients()** currently fills `clientSelect`, `fxClientSelect`, `fdmClientSelect`, `vrClientSelect`. After merge, fill only **three** client dropdowns: Trust Ops, Framework Explorer (the single one), Vendor Risk. So remove `fdmClientSelect` from the list of selects to fill (and from the DOM).

---

## Tests and documents: verification

- **Framework Explorer (step-by-step):** Selecting a control calls `WD_getControlDetails`, which returns `{ tests, documents }`. The UI already shows “Tests (n)” and “Documents (n)” in `fxRenderDetails`. No change needed for correctness.
- **Full map:** `WD_getFrameworkDocMap` returns `{ controls: [{ tests, documents }, ...] }` once `WD_fetchFrameworkDocMapDirect_` is implemented. The existing `fdmRenderDocMap` already iterates `ctrl.tests` and `ctrl.documents` and renders both sections. No change needed for correctness.
- After adding `WD_fetchFrameworkDocMapDirect_` to the target, run “Load full map” for a framework and confirm each control row shows both Tests and Documents sections with data.

---

## Summary

- **One module:** Framework Explorer (or “Frameworks & Controls”).
- **One client selector, one framework selector** for both Explore and Full map.
- **Two ways to view:** (1) Explore: three columns, step-by-step loading; (2) Full map: expandable list from cached (or live) data, with optional FrameworkMappingDB sync.
- **Tests and documents** are included in both paths; ensure target has `WD_fetchFrameworkDocMapDirect_` so the full-map API returns both.
- Remove the Control Mapping nav entry and its section; merge its behavior and UI into the single Framework Explorer section and script state.
