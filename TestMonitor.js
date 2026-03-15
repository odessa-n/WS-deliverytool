/**
 * TestMonitor.gs — Test & Document monitoring across all active Vanta clients.
 *
 * ── THREE-LAYER ARCHITECTURE ────────────────────────────────────────────────
 *
 *  Layer 1 · TMCache sheet  (expensive, rebuilt rarely)
 *    Stores framework maps per client:
 *      { testId: "SOC 2, ISO 27001:2022", ... }   → TestFrameworkMap column
 *      { docId:  "SOC 2", ... }                    → DocFrameworkMap   column
 *    Built by traversing: Frameworks → Controls → Tests/Docs via Vanta API.
 *    Valid for TM_CACHE_MAX_AGE_DAYS days. Auto-invalidated if frameworks change.
 *    Rebuild manually: TM_rebuildAllCaches() / "Rebuild ID Cache" button.
 *
 *  Layer 2 · Per-client sheets  "TM: ClientName"  (refreshed on demand / scheduled)
 *    Full row-level data written on every client refresh.
 *    13 columns: id | name | description | status | remediationStatus | category |
 *                framework | Scoped | type | isDeactivated |
 *                soonestRemediateByDate | failingEntitiesCount | failingEntities
 *    The `framework` and `Scoped` columns are populated from FrameworkMappingDB (name-based)
 *    or TMCache (ID-based fallback).
 *    Source of truth for all metric calculations — no numbers are stored here,
 *    only raw row data.
 *
 *  Layer 3 · "Test Monitor" summary sheet  (derived, never edited manually)
 *    One row per client. Aggregated metrics calculated by reading Layer 2.
 *    11 columns: Client | Frameworks | All Tests | Scoped Tests | Outstanding Tests |
 *                Deactivated Tests | All Docs | Scoped Docs | Outstanding Docs |
 *                Deactivated Docs | Updated At
 *    Read by TM_getTestMonitorData() and returned to the frontend.
 *
 *  REFRESH FLOW (frontend-triggered, streaming):
 *    1. Frontend calls TM_refreshSelectedClients([name]) for each client.
 *    2. TM_fetchClientTestSummary_: checks TMCache → fetches Vanta API →
 *       writes TM: ClientName sheet → calculates metrics → returns summary.
 *    3. TM_upsertClientRow_ writes the summary to Test Monitor sheet.
 *    4. Frontend updates DOM row immediately; moves to next client.
 *
 *  CACHE REBUILD (automatic, inline):
 *    On every per-client refresh, TM_fetchClientTestSummary_ checks TMCache.
 *    If the cache is missing, stale (> TM_CACHE_MAX_AGE_DAYS), or the stored
 *    frameworks string has changed, the maps are rebuilt automatically before
 *    fetching tests/docs. No separate rebuild step is needed.
 *
 *  RECALC-ONLY FLOW (recalc from existing sheets, no API calls):
 *    TM_recalcClientFromSheet_(clientName) — reads the existing TM: ClientName
 *    sheet and recalculates the summary row. Use this when only the framework
 *    maps changed and you want to re-scope without re-fetching all tests/docs.
 * ────────────────────────────────────────────────────────────────────────────
 */

var TM_SHEET_NAME           = 'Test Monitor';
var TM_CACHE_SHEET_NAME     = 'TMCache';
var TM_CLIENT_SHEET_PREFIX  = 'TM: ';
var TM_LAST_REFRESH_KEY     = 'TM_LAST_REFRESH';
var TM_CACHE_MAX_AGE_DAYS   = 7;
var TM_INTER_CLIENT_SLEEP_MS = 2000;

// Summary sheet columns
var TM_COLS = [
  'Client', 'Frameworks',
  'All Tests', 'Scoped Tests', 'Outstanding Tests', 'Deactivated Tests',
  'All Docs',  'Scoped Docs',  'Outstanding Docs',  'Deactivated Docs',
  'Updated At'
];

// Per-client detail sheet columns — matches reference client monitoring format
var TM_CLIENT_SHEET_HEADERS = [
  'id', 'name', 'description', 'status', 'remediationStatus', 'category',
  'framework', 'Scoped', 'type', 'isDeactivated',
  'soonestRemediateByDate', 'failingEntitiesCount', 'failingEntities'
];

// Cache sheet columns
// TestFrameworkMap / DocFrameworkMap: JSON objects { id: "fw1, fw2", ... }
var TM_CACHE_COLS = ['Client', 'Frameworks', 'TestFrameworkMap', 'DocFrameworkMap', 'UpdatedAt'];

// ── Public API ────────────────────────────────────────────────────────────────

function TM_getTestMonitorData() {
  var sheet = TM_getOrCreateSheet_();
  var rows  = sheet.getDataRange().getValues();
  var lastRefresh = PropertiesService.getScriptProperties().getProperty(TM_LAST_REFRESH_KEY) || null;

  var dbMap = WD_readAllClientDb_();
  var data  = [];
  var seen  = {};

  // ── Build rows from existing Test Monitor sheet data ──────────────────
  if (rows.length >= 2) {
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!String(row[0] || '').trim()) continue;

      var clientName = String(row[0] || '').trim();
      var dbEntry    = dbMap[clientName.toLowerCase()] || {};

      if ((dbEntry.clientStatus || 'Active').trim().toLowerCase() === 'inactive') continue;

      var frameworks       = (dbEntry.frameworks || String(row[1] || '')).trim();
      var allTests         = Number(row[2])  || 0;
      var scopedTests      = Number(row[3])  || 0;
      var outTests         = Number(row[4])  || 0;
      var deactivatedTests = Number(row[5])  || 0;
      var allDocs          = Number(row[6])  || 0;
      var scopedDocs       = Number(row[7])  || 0;
      var outDocs          = Number(row[8])  || 0;
      var deactivatedDocs  = Number(row[9])  || 0;
      var updatedAt        = row[10] ? String(row[10]) : null;

      var activeTests  = Math.max(0, scopedTests - deactivatedTests);
      var passingTests = Math.max(0, activeTests - outTests);
      var testPct      = activeTests > 0 ? Math.round(passingTests / activeTests * 100) : 0;

      var activeDocs   = Math.max(0, scopedDocs - deactivatedDocs);
      var passingDocs  = Math.max(0, activeDocs - outDocs);
      var docPct       = activeDocs > 0 ? Math.round(passingDocs / activeDocs * 100) : 0;

      var totalActive  = activeTests + activeDocs;
      var totalOut     = outTests + outDocs;
      var completedPct = totalActive > 0
        ? Math.round(Math.max(0, totalActive - totalOut) / totalActive * 100) : 0;

      seen[clientName.toLowerCase()] = true;
      data.push({
        clientName:       clientName,
        frameworks:       frameworks,
        allTests:         allTests,
        scopedTests:      scopedTests,
        outTests:         outTests,
        deactivatedTests: deactivatedTests,
        activeTests:      activeTests,
        testPct:          testPct,
        allDocs:          allDocs,
        scopedDocs:       scopedDocs,
        outDocs:          outDocs,
        deactivatedDocs:  deactivatedDocs,
        activeDocs:       activeDocs,
        docPct:           docPct,
        totalOut:         totalOut,
        totalActive:      totalActive,
        completedPct:     completedPct,
        updatedAt:        updatedAt
      });
    }
  }

  // ── Add placeholder rows for active clients not yet in the sheet ───────
  // Ensures the client list is always visible even before first refresh.
  Object.keys(dbMap).forEach(function(key) {
    if (seen[key]) return;
    var dbEntry = dbMap[key];
    if ((dbEntry.clientStatus || 'Active').trim().toLowerCase() === 'inactive') return;
    var name = dbEntry.clientName || dbEntry.name || key;
    if (!name) return;
    data.push({
      clientName:       name,
      frameworks:       (dbEntry.frameworks || '').trim(),
      allTests:         0, scopedTests:      0, outTests:         0, deactivatedTests: 0,
      activeTests:      0, testPct:          0,
      allDocs:          0, scopedDocs:       0, outDocs:          0, deactivatedDocs:  0,
      activeDocs:       0, docPct:           0,
      totalOut:         0, totalActive:      0, completedPct:     0,
      updatedAt:        null
    });
  });

  return { rows: data, lastRefresh: lastRefresh };
}

/**
 * Phase 1 — fetch tests & documents from Vanta, write the TM: ClientName sheet,
 * and update the Test Monitor summary row.
 * Returns a single row object for immediate frontend merge.
 */
function TM_refreshClientData(clientName) {
  var row = TM_fetchClientPhase1_(clientName);
  PropertiesService.getScriptProperties().setProperty(TM_LAST_REFRESH_KEY, new Date().toISOString());
  return row;
}

/**
 * Phase 2 — build/check framework maps, update the `framework` and `Scoped`
 * columns in the existing TM: ClientName sheet, and recalculate metrics.
 * Returns an updated row object, or null if the client has no frameworks or
 * no existing sheet (Phase 1 has not run yet).
 */
function TM_enrichClientFrameworks(clientName) {
  return TM_fetchClientPhase2_(clientName);
}

/**
 * Bulk two-pass refresh used by the scheduled trigger.
 * Pass 1: tests/docs for all clients (fast — 2-3 API calls each).
 * Pass 2: framework enrichment (uses TMCache where possible).
 */
function TM_refreshAllClients() {
  var clients;
  try { clients = WD_getActiveClients(); }
  catch (e) { throw new Error('Could not load client list: ' + e.message); }
  if (!clients || !clients.length) throw new Error('No clients found to refresh.');

  var errors = [];

  // Pass 1 — tests/docs
  for (var i = 0; i < clients.length; i++) {
    if (i > 0) Utilities.sleep(TM_INTER_CLIENT_SLEEP_MS);
    try { TM_fetchClientPhase1_(clients[i]); }
    catch (e) {
      errors.push('[P1] ' + clients[i] + ': ' + e.message);
      Logger.log('TM P1 error [' + clients[i] + ']: ' + e.toString());
    }
  }

  // Pass 2 — framework enrichment (separate wave avoids rate-limiting P1 calls)
  Utilities.sleep(5000);
  for (var j = 0; j < clients.length; j++) {
    if (j > 0) Utilities.sleep(TM_INTER_CLIENT_SLEEP_MS);
    try { TM_fetchClientPhase2_(clients[j]); }
    catch (e) {
      errors.push('[P2] ' + clients[j] + ': ' + e.message);
      Logger.log('TM P2 error [' + clients[j] + ']: ' + e.toString());
    }
  }

  PropertiesService.getScriptProperties().setProperty(TM_LAST_REFRESH_KEY, new Date().toISOString());
  return { errors: errors };
}

// ── Scheduled trigger ─────────────────────────────────────────────────────────

function TM_scheduledRefresh_() {
  try { TM_refreshAllClients(); }
  catch (e) { Logger.log('TM_scheduledRefresh_ error: ' + e.toString()); }
}

/**
 * Run ONCE from Apps Script editor.
 * Script timezone: Asia/Manila (UTC+8).
 *   6 AM EST = 19:00 Manila | 12 PM EST = 01:00 Manila
 */
function TM_setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'TM_scheduledRefresh_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('TM_scheduledRefresh_').timeBased().atHour(19).everyDays(1).create();
  ScriptApp.newTrigger('TM_scheduledRefresh_').timeBased().atHour(1).everyDays(1).create();
  Logger.log('TM triggers created: 7 PM and 1 AM Manila.');
}

// ── Core fetch + sync (private) ───────────────────────────────────────────────

/**
 * Phase 1 — fetches all tests & docs from the Vanta API, writes the
 * TM: ClientName sheet with Scoped=Yes for all rows (no framework filtering),
 * updates the summary row, and returns a frontend-ready row object.
 *
 * Kept intentionally minimal: only calls /tests and /documents (2 paginated
 * endpoints), so it doesn't trigger rate limits that affect Phase 2.
 */
function TM_fetchClientPhase1_(clientName) {
  var token       = WD_getVantaAccessToken_(clientName);
  var meta        = WD_getClientMetadata(clientName);
  var storedFwStr = (meta.frameworks || '').trim();

  // Fetch all tests + docs
  var allTestsList = WD_fetchAllTests_(token);
  var allDocsList  = WD_fetchAllDocsAllStatuses_(token);

  Logger.log('TM P1 [' + clientName + ']: ' +
    allTestsList.length + ' tests, ' + allDocsList.length + ' docs');

  // Fetch failing entities for NEEDS_ATTENTION tests
  var entityMap = TM_buildEntityMap_(token, allTestsList);

  // Pre-load scoping maps from FrameworkMappingDB (if populated) so Phase 1 writes
  // accurate Scoped values from the start instead of defaulting everything to Yes.
  // TM_writeClientSheet_ takes ID-based maps, so we convert from name-based here.
  var initialTestMap = null;
  var initialDocMap  = null;
  if (storedFwStr) {
    var clientFwsArr = storedFwStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var prebuilt = FMDB_buildScopingMaps_(clientFwsArr);
    var hasPrebuilt = Object.keys(prebuilt.testsById).length > 0 ||
                      Object.keys(prebuilt.docsById).length  > 0 ||
                      Object.keys(prebuilt.testsByName).length > 0 ||
                      Object.keys(prebuilt.docsByName).length  > 0;
    if (hasPrebuilt) {
      initialTestMap = {};
      initialDocMap  = {};
      allTestsList.forEach(function(t) {
        var id        = t.id || t.testId;
        var nameLower = String(t.name || t.displayName || '').trim().toLowerCase();
        if (!id) return;
        if (prebuilt.testsById[id]) {
          initialTestMap[id] = prebuilt.testsById[id];
        } else if (nameLower && prebuilt.testsByName[nameLower]) {
          initialTestMap[id] = prebuilt.testsByName[nameLower];
        }
      });
      allDocsList.forEach(function(d) {
        var id        = d.id || d.documentId;
        var nameLower = String(d.name || d.title || d.documentName || '').trim().toLowerCase();
        if (!id) return;
        if (prebuilt.docsById[id]) {
          initialDocMap[id] = prebuilt.docsById[id];
        } else if (nameLower && prebuilt.docsByName[nameLower]) {
          initialDocMap[id] = prebuilt.docsByName[nameLower];
        }
      });
      Logger.log('TM P1 [' + clientName + ']: pre-scoped from FrameworkMappingDB — ' +
        Object.keys(initialTestMap).length + ' tests, ' +
        Object.keys(initialDocMap).length + ' docs scoped.');
    }
  }

  // Write sheet — uses FrameworkMappingDB scoping if available, otherwise Scoped=Yes (preliminary)
  var clientSheet = TM_getOrCreateClientSheet_(clientName);
  TM_writeClientSheet_(clientSheet, allTestsList, allDocsList, initialTestMap, initialDocMap, entityMap);

  var summary = TM_calculateMetricsFromSheet_(clientSheet, storedFwStr);
  TM_upsertClientRow_(clientName, summary);
  return TM_buildRowObject_(clientName, summary);
}

/**
 * Phase 2 — builds or reads TMCache framework maps for this client, updates
 * the `framework` and `Scoped` columns in the existing TM: ClientName sheet,
 * recalculates metrics, and returns an updated row object.
 *
 * Returns null if:
 *   - No frameworks are configured for the client (Phase 1 result is already final)
 *   - No TM: ClientName sheet exists (Phase 1 hasn't run yet)
 *   - Framework IDs could not be resolved
 */
function TM_fetchClientPhase2_(clientName) {
  var meta        = WD_getClientMetadata(clientName);
  var storedFwStr = (meta.frameworks || '').trim();

  if (!storedFwStr) {
    Logger.log('TM P2 [' + clientName + ']: no frameworks configured, skipping.');
    return null;
  }

  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(TM_CLIENT_SHEET_PREFIX + clientName);
  if (!sheet) {
    Logger.log('TM P2 [' + clientName + ']: no sheet — run Phase 1 first.');
    return null;
  }

  var testFrameworkMap, docFrameworkMap;

  // Use TMCache if valid; only fetch a token if a rebuild is needed
  var cache      = TM_readClientCache_(clientName);
  var cacheValid = cache &&
                   (cache.frameworks || '').trim() === storedFwStr &&
                   !TM_isCacheStale_(cache.updatedAt);

  if (cacheValid) {
    testFrameworkMap = cache.testFrameworkMap;
    docFrameworkMap  = cache.docFrameworkMap;
    Logger.log('TM P2 [' + clientName + ']: using cached framework maps (' +
      Object.keys(testFrameworkMap).length + ' tests, ' +
      Object.keys(docFrameworkMap).length + ' docs)');
    // No upsert on cache hits — central DB was populated when the cache was built
  } else {
    var token = WD_getVantaAccessToken_(clientName);
    Logger.log('TM P2 [' + clientName + ']: rebuilding framework maps...');
    var resolvedFrameworks = TM_resolveFrameworks_(token, storedFwStr);
    if (!resolvedFrameworks.length) {
      Logger.log('TM P2 [' + clientName + ']: could not resolve frameworks.');
      return null;
    }
    var maps = TM_buildFrameworkMaps_(token, resolvedFrameworks);
    testFrameworkMap = maps.testFrameworkMap;
    docFrameworkMap  = maps.docFrameworkMap;
    TM_writeClientCache_(clientName, storedFwStr, testFrameworkMap, docFrameworkMap);
    Logger.log('TM P2 [' + clientName + ']: cache written. docNameMap has ' +
      Object.keys(maps.docNameMap).length + ' names for ' +
      Object.keys(docFrameworkMap).length + ' doc IDs in framework map.');

    // Supplement docNameMap from the TM: client sheet for any IDs not resolved via
    // the /documents endpoint (e.g. IDs returned by /controls/{id}/documents that
    // differ in format from the full /documents list).
    TM_supplementDocNames_(maps.docNameMap, sheet);
    Logger.log('TM P2 [' + clientName + ']: docNameMap after supplement: ' +
      Object.keys(maps.docNameMap).length + ' names for ' +
      Object.keys(docFrameworkMap).length + ' doc IDs in framework map.');

    // Upsert into central FrameworkMappingDB (only on cache-miss when we have fresh names)
    try {
      FMDB_upsertFromMaps_(testFrameworkMap, docFrameworkMap, maps.testNameMap, maps.docNameMap, sheet);
      Logger.log('TM P2 [' + clientName + ']: FrameworkMappingDB upserted.');
    } catch (e) {
      Logger.log('TM P2 [' + clientName + ']: FrameworkMappingDB upsert failed (non-fatal): ' + e.message);
    }
  }

  // ── Apply scoping: ID-first (central DB) with name fallback ─────────────
  var clientFwsArr   = storedFwStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var centralMaps    = FMDB_buildScopingMaps_(clientFwsArr);
  var hasCentralData = Object.keys(centralMaps.testsById).length   > 0 ||
                       Object.keys(centralMaps.docsById).length    > 0 ||
                       Object.keys(centralMaps.testsByName).length > 0 ||
                       Object.keys(centralMaps.docsByName).length  > 0;

  if (hasCentralData) {
    Logger.log('TM P2 [' + clientName + ']: applying scoping from FrameworkMappingDB (' +
      Object.keys(centralMaps.testsById).length   + ' tests by ID, ' +
      Object.keys(centralMaps.docsById).length    + ' docs by ID, ' +
      Object.keys(centralMaps.testsByName).length + ' tests by name, ' +
      Object.keys(centralMaps.docsByName).length  + ' docs by name).');
    FMDB_updateSheetScoping_(sheet, centralMaps);
  } else {
    // Fallback: raw ID-based scoping from the live traversal maps
    Logger.log('TM P2 [' + clientName + ']: FrameworkMappingDB empty for these frameworks — falling back to ID-based scoping.');
    TM_updateSheetFrameworks_(sheet, testFrameworkMap, docFrameworkMap);
  }

  var summary = TM_calculateMetricsFromSheet_(sheet, storedFwStr);
  TM_upsertClientRow_(clientName, summary);
  return TM_buildRowObject_(clientName, summary);
}

// ── Phase helpers ─────────────────────────────────────────────────────────────

/**
 * Supplements docNameMap (id → display name) using the per-client TM: sheet.
 *
 * The /controls/{id}/documents endpoint often returns slim document references
 * that include an ID but no name field.  Since Phase 1 already wrote full doc
 * objects (with names) to the TM: sheet via the /documents endpoint, we can
 * cross-reference here so every doc ID in docFrameworkMap gets a name.
 *
 * Mutates docNameMap in-place (only fills gaps — never overwrites existing names).
 *
 * @param {Object} docNameMap   { docId: "display name" }  — mutated in place
 * @param {Sheet}  clientSheet  TM: ClientName sheet written by Phase 1
 */
function TM_supplementDocNames_(docNameMap, clientSheet) {
  if (!clientSheet) return;
  var data = clientSheet.getDataRange().getValues();
  if (data.length < 2) return;

  var hdr     = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol   = hdr.indexOf('id');
  var nameCol = hdr.indexOf('name');
  var typeCol = hdr.indexOf('type');
  if (idCol < 0 || nameCol < 0 || typeCol < 0) return;

  for (var i = 1; i < data.length; i++) {
    var type = String(data[i][typeCol] || '').trim();
    if (type !== 'Documents') continue;
    var id   = String(data[i][idCol]   || '').trim();
    var name = String(data[i][nameCol] || '').trim();
    if (id && name && !docNameMap[id]) docNameMap[id] = name;
  }
}

/** Fetches failing entity names for all NEEDS_ATTENTION tests. */
function TM_buildEntityMap_(token, testsList) {
  var entityMap         = {};
  var needsAttentionIds = [];

  testsList.forEach(function(t) {
    var st = String(t.status || '').trim().toUpperCase();
    if (st === 'NEEDS_ATTENTION' || st === 'NEEDS ATTENTION') {
      var id = String(t.id || t.testId || '');
      if (id) needsAttentionIds.push(id);
    }
  });

  if (needsAttentionIds.length) {
    try {
      var rawEntityMap = WD_fetchEntitiesBatch_(token, needsAttentionIds);
      Object.keys(rawEntityMap).forEach(function(id) {
        var names = rawEntityMap[id] || [];
        // Truncate entity string to fit within the 50,000-char cell limit.
        // Trim at the last ' | ' separator before 45,000 chars so we don't
        // cut in the middle of a name. Count is always accurate.
        var entityStr = names.join(' | ');
        if (entityStr.length > 45000) {
          var cut = entityStr.lastIndexOf(' | ', 44900);
          entityStr = (cut > 0 ? entityStr.substring(0, cut) : entityStr.substring(0, 44900)) +
                      ' … (+' + names.length + ' total)';
        }
        entityMap[id] = { count: names.length, names: entityStr };
      });
    } catch (e) {
      Logger.log('TM buildEntityMap failed (non-fatal): ' + e.message);
    }
  }
  return entityMap;
}

/**
 * Updates the `framework` and `Scoped` columns in an existing TM: ClientName
 * sheet using the provided framework maps. No API calls made.
 * Reads the full sheet, applies map lookups row-by-row, and writes back.
 */
function TM_updateSheetFrameworks_(sheet, testFrameworkMap, docFrameworkMap) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  var hdr     = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol   = hdr.indexOf('id');
  var typeCol = hdr.indexOf('type');
  var fwCol   = hdr.indexOf('framework');
  var scCol   = hdr.indexOf('scoped');

  if (idCol < 0 || fwCol < 0 || scCol < 0) {
    Logger.log('TM_updateSheetFrameworks_: missing columns. idCol=' + idCol +
      ' fwCol=' + fwCol + ' scCol=' + scCol + ' headers=' + JSON.stringify(data[0]));
    return;
  }

  var updatedTests = 0, updatedDocs = 0, skipped = 0;

  for (var i = 1; i < data.length; i++) {
    var id   = String(data[i][idCol]   || '').trim();
    var type = String(data[i][typeCol] || '').trim();
    if (!id || !type) { skipped++; continue; }

    if (type === 'Automated Test') {
      data[i][fwCol] = testFrameworkMap[id] || '';
      data[i][scCol] = testFrameworkMap[id] ? 'Yes' : 'No';
      updatedTests++;
    } else if (type === 'Documents') {
      data[i][fwCol] = docFrameworkMap[id] || '';
      data[i][scCol] = docFrameworkMap[id] ? 'Yes' : 'No';
      updatedDocs++;
    }
  }

  Logger.log('TM_updateSheetFrameworks_: updated ' + updatedTests + ' tests, ' +
    updatedDocs + ' docs (' + skipped + ' skipped). ' +
    'Tests in map: ' + Object.keys(testFrameworkMap).length +
    ', Docs in map: ' + Object.keys(docFrameworkMap).length);

  // Log a sample of sheet IDs vs map IDs to diagnose mismatches
  if (updatedTests > 0 && Object.keys(testFrameworkMap).length > 0) {
    var sheetSample = [];
    for (var r = 1; r < Math.min(data.length, 4); r++) {
      if (String(data[r][typeCol] || '') === 'Automated Test') {
        sheetSample.push(String(data[r][idCol] || ''));
      }
    }
    var mapSample = Object.keys(testFrameworkMap).slice(0, 3);
    Logger.log('TM_updateSheetFrameworks_ ID sample — sheet: ' + JSON.stringify(sheetSample) +
      ' | map: ' + JSON.stringify(mapSample));
  }

  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

/** Builds the frontend row object from a summary (same shape as TM_getTestMonitorData rows). */
function TM_buildRowObject_(clientName, summary) {
  var activeTests  = Math.max(0, (summary.scopedTests || 0) - (summary.deactivatedTests || 0));
  var passingTests = Math.max(0, activeTests - (summary.outTests || 0));
  var testPct      = activeTests > 0 ? Math.round(passingTests / activeTests * 100) : 0;

  var activeDocs   = Math.max(0, (summary.scopedDocs || 0) - (summary.deactivatedDocs || 0));
  var passingDocs  = Math.max(0, activeDocs - (summary.outDocs || 0));
  var docPct       = activeDocs > 0 ? Math.round(passingDocs / activeDocs * 100) : 0;

  var totalActive  = activeTests + activeDocs;
  var totalOut     = (summary.outTests || 0) + (summary.outDocs || 0);
  var completedPct = totalActive > 0
    ? Math.round(Math.max(0, totalActive - totalOut) / totalActive * 100) : 0;

  return {
    clientName:       clientName,
    frameworks:       summary.frameworks       || '',
    allTests:         summary.allTests         || 0,
    scopedTests:      summary.scopedTests      || 0,
    outTests:         summary.outTests         || 0,
    deactivatedTests: summary.deactivatedTests || 0,
    activeTests:      activeTests,
    testPct:          testPct,
    allDocs:          summary.allDocs          || 0,
    scopedDocs:       summary.scopedDocs       || 0,
    outDocs:          summary.outDocs          || 0,
    deactivatedDocs:  summary.deactivatedDocs  || 0,
    activeDocs:       activeDocs,
    docPct:           docPct,
    totalOut:         totalOut,
    totalActive:      totalActive,
    completedPct:     completedPct,
    updatedAt:        new Date().toISOString()
  };
}

/**
 * Writes the per-client detail sheet, matching the reference format.
 * Clears existing data and rewrites from scratch on each refresh.
 */
function TM_writeClientSheet_(sheet, tests, docs, testFrameworkMap, docFrameworkMap, entityMap) {
  sheet.clear();
  sheet.getRange(1, 1, 1, TM_CLIENT_SHEET_HEADERS.length).setValues([TM_CLIENT_SHEET_HEADERS]);
  sheet.setFrozenRows(1);

  var rows = [];
  entityMap = entityMap || {};

  // ── Tests ──────────────────────────────────────────────────────────────
  for (var ti = 0; ti < tests.length; ti++) {
    var t = tests[ti];
    var id = String(t.id || t.testId || '');
    var status = String(t.status || '').trim();

    var isDeactivated = t.isDeactivated === true ||
                        status.toUpperCase() === 'DEACTIVATED';

    // framework column: comma-separated names from the map; empty if not in any client framework
    var framework = testFrameworkMap ? (testFrameworkMap[id] || '') : '';
    var scoped    = testFrameworkMap ? (testFrameworkMap[id] ? 'Yes' : 'No') : 'Yes';

    // remediationStatus and soonestRemediateByDate
    var remInfo          = t.remediationStatusInfo || {};
    var remediationStatus = String(remInfo.status || '').trim();
    var soonestDate       = String(remInfo.soonestRemediateByDate ||
                                   remInfo.soonestDueByDate || '').trim();

    // Failing entities (only populated for NEEDS_ATTENTION tests)
    var entityData        = entityMap[id] || {};
    var failingCount      = entityData.count || '';
    var failingEntities   = entityData.names || '';

    rows.push([
      id,
      String(t.name || t.displayName || '').trim(),
      String(t.description || t.shortDescription || '').trim(),
      status,
      remediationStatus,
      String(t.category || '').trim(),
      framework,
      scoped,
      'Automated Test',
      isDeactivated,
      soonestDate,
      failingCount,
      failingEntities
    ]);
  }

  // ── Documents ──────────────────────────────────────────────────────────
  for (var di = 0; di < docs.length; di++) {
    var d = docs[di];
    var did     = String(d.id || d.documentId || '');
    var dStatus = String(d.status || '').trim();

    // "Not relevant" is the deactivated equivalent for documents
    var dIsDeactivated = dStatus.toUpperCase() === 'NOT RELEVANT';
    var dFramework = docFrameworkMap ? (docFrameworkMap[did] || '') : '';
    var dScoped    = docFrameworkMap ? (docFrameworkMap[did] ? 'Yes' : 'No') : 'Yes';

    rows.push([
      did,
      String(d.name || d.title || d.documentName || '').trim(),
      String(d.description || d.shortDescription || '').trim(),
      dStatus,
      '',            // remediationStatus — N/A for documents
      String(d.category || d.categoryName || '').trim(),
      dFramework,
      dScoped,
      'Documents',
      dIsDeactivated,
      '',            // soonestRemediateByDate — N/A
      '',            // failingEntitiesCount — N/A
      ''             // failingEntities — N/A
    ]);
  }

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TM_CLIENT_SHEET_HEADERS.length).setValues(rows);
  }

  sheet.autoResizeColumns(1, TM_CLIENT_SHEET_HEADERS.length);
}

/**
 * Reads a per-client detail sheet and returns the 8 summary metrics.
 * Single read pass — O(n).
 */
function TM_calculateMetricsFromSheet_(sheet, frameworks) {
  var empty = {
    frameworks: frameworks,
    allTests: 0, scopedTests: 0, outTests: 0, deactivatedTests: 0,
    allDocs:  0, scopedDocs:  0, outDocs:  0, deactivatedDocs:  0
  };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return empty;

  // Locate columns by header name (case-insensitive, order-independent)
  var hdr = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var COL = {
    status:        hdr.indexOf('status'),
    type:          hdr.indexOf('type'),
    isDeactivated: hdr.indexOf('isdeactivated'),
    scoped:        hdr.indexOf('scoped')
  };

  var allTests = 0, scopedTests = 0, outTests = 0, deactivatedTests = 0;
  var allDocs  = 0, scopedDocs  = 0, outDocs  = 0, deactivatedDocs  = 0;

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var type = String(row[COL.type] || '').trim();
    if (!type) continue;

    var status        = String(row[COL.status] || '').trim();
    var isDeactivated = row[COL.isDeactivated] === true ||
                        String(row[COL.isDeactivated]).toLowerCase() === 'true';
    var scoped        = String(row[COL.scoped] || '').trim() === 'Yes';
    var ns            = WD_normalizeStatus_(status);

    if (type === 'Automated Test') {
      allTests++;
      if (scoped) {
        scopedTests++;
        if (isDeactivated)             deactivatedTests++;
        else if (ns === 'Outstanding') outTests++;
      }
    } else if (type === 'Documents') {
      allDocs++;
      if (scoped) {
        scopedDocs++;
        if (isDeactivated)             deactivatedDocs++;
        else if (ns === 'Outstanding') outDocs++;
      }
    }
  }

  return {
    frameworks: frameworks,
    allTests:         allTests,
    scopedTests:      scopedTests,
    outTests:         outTests,
    deactivatedTests: deactivatedTests,
    allDocs:          allDocs,
    scopedDocs:       scopedDocs,
    outDocs:          outDocs,
    deactivatedDocs:  deactivatedDocs
  };
}

// ── Framework resolution + map building ───────────────────────────────────────

/**
 * Resolves a comma-separated framework name string to [{ id, name }] objects.
 * Matching is case-insensitive. Uses partial/contained matching as fallback:
 *   stored "SOC 2" matches Vanta "SOC 2 Type II", and vice versa.
 * Logs the available Vanta framework names so mismatches are easy to spot.
 */
function TM_resolveFrameworks_(token, storedFwStr) {
  if (!storedFwStr || !storedFwStr.trim()) return [];

  var storedKeys = storedFwStr.split(',').map(function(n) {
    return n.trim().toLowerCase();
  }).filter(Boolean);

  var allFrameworks = WD_fetchFrameworks_(token);
  Logger.log('TM_resolveFrameworks_: stored="' + storedFwStr + '" | Vanta has ' +
    allFrameworks.length + ' frameworks: ' +
    allFrameworks.map(function(f) {
      return (f.name || f.displayName || f.id || '');
    }).join(' | '));

  var resolved = [];
  var resolvedIds = {};

  allFrameworks.forEach(function(fw) {
    var fwName = (fw.name || fw.displayName || fw.id || '').trim();
    var fwKey  = fwName.toLowerCase();
    if (!fwName || resolvedIds[fw.id]) return;

    for (var si = 0; si < storedKeys.length; si++) {
      var stored = storedKeys[si];
      // Exact match first, then partial (either direction)
      if (fwKey === stored ||
          fwKey.indexOf(stored) >= 0 ||
          stored.indexOf(fwKey) >= 0) {
        resolved.push({ id: fw.id, name: fwName });
        resolvedIds[fw.id] = true;
        break;
      }
    }
  });

  Logger.log('TM_resolveFrameworks_: resolved ' + resolved.length + ' framework(s): ' +
    resolved.map(function(f) { return f.name + '(' + f.id + ')'; }).join(', '));
  return resolved;
}

/**
 * Traverses each framework → controls → tests/docs and builds reverse maps:
 *   testFrameworkMap: { testId: "SOC 2, ISO 27001:2022" }
 *   docFrameworkMap:  { docId:  "SOC 2" }
 *
 * Also captures display names during traversal (used by FrameworkMappingDB):
 *   testNameMap: { testId: "display name" }
 *   docNameMap:  { docId:  "display name" }
 *
 * Uses UrlFetchApp.fetchAll for batched parallel control-level calls.
 */
function TM_buildFrameworkMaps_(token, resolvedFrameworks) {
  var testFrameworkMap = {};
  var docFrameworkMap  = {};
  var testNameMap      = {}; // id → display name (captured during test traversal)
  var docNameMap       = {}; // id → display name
  var BATCH = 20;

  var headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };

  // Pre-fetch all docs with full objects so we have names available.
  // The /controls/{id}/documents endpoint returns slim references (title field may
  // be absent or inconsistent). The /documents endpoint always has full names.
  // This mirrors how Framework Explorer works: fetch full docs first, then use
  // control traversal only for the framework→doc association.
  var allDocsList = WD_fetchAllDocsAllStatuses_(token);
  allDocsList.forEach(function(d) {
    var id   = d.id || d.documentId;
    var name = String(d.name || d.title || d.documentName || d.fileName || '').trim();
    if (id && name) docNameMap[id] = name;
  });
  Logger.log('TM_buildFrameworkMaps_: pre-loaded ' + Object.keys(docNameMap).length +
    ' doc names from /documents endpoint.');

  for (var fi = 0; fi < resolvedFrameworks.length; fi++) {
    var fw     = resolvedFrameworks[fi];
    var fwName = fw.name;

    // Fetch all controls for this framework
    var controls   = WD_fetchFrameworkControls_(token, fw.id);
    var controlIds = controls.map(function(c) { return c.id; }).filter(Boolean);

    if (!controlIds.length) continue;

    // Batch-fetch tests for all controls
    for (var ci = 0; ci < controlIds.length; ci += BATCH) {
      var batch = controlIds.slice(ci, ci + BATCH);
      var reqs  = batch.map(function(cid) {
        return {
          url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(cid) +
               '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
          method: 'get', headers: headers, muteHttpExceptions: true
        };
      });
      var resps = UrlFetchApp.fetchAll(reqs);
      resps.forEach(function(resp) {
        if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return;
        var data = ((JSON.parse(resp.getContentText() || '{}').results) || {}).data || [];
        data.forEach(function(t) {
          var id = t && (t.id || t.testId);
          if (!id) return;
          var name = t && (t.name || t.displayName || t.testName || '');
          if (name && !testNameMap[id]) testNameMap[id] = String(name).trim();
          if (testFrameworkMap[id]) {
            if (testFrameworkMap[id].split(', ').indexOf(fwName) < 0) {
              testFrameworkMap[id] += ', ' + fwName;
            }
          } else {
            testFrameworkMap[id] = fwName;
          }
        });
      });
      if (ci + BATCH < controlIds.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
    }

    // Batch-fetch doc IDs for all controls and build docFrameworkMap.
    // Names come from the pre-loaded docNameMap (full /documents response) above.
    for (var di = 0; di < controlIds.length; di += BATCH) {
      var dbatch = controlIds.slice(di, di + BATCH);
      var dreqs  = dbatch.map(function(cid) {
        return {
          url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(cid) +
               '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
          method: 'get', headers: headers, muteHttpExceptions: true
        };
      });
      var dresps = UrlFetchApp.fetchAll(dreqs);
      dresps.forEach(function(resp) {
        if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return;
        var parsed = JSON.parse(resp.getContentText() || '{}');
        var data   = (parsed.results && parsed.results.data) ||
                     parsed.data ||
                     (Array.isArray(parsed) ? parsed : []);
        data.forEach(function(d) {
          var id = d && (d.id || d.documentId);
          if (!id) return;
          // Capture name from control-documents response (parallel to test traversal above)
          var dname = String((d && (d.name || d.title || d.displayName || d.documentName)) || '').trim();
          if (dname && !docNameMap[id]) docNameMap[id] = dname;
          if (docFrameworkMap[id]) {
            if (docFrameworkMap[id].split(', ').indexOf(fwName) < 0) {
              docFrameworkMap[id] += ', ' + fwName;
            }
          } else {
            docFrameworkMap[id] = fwName;
          }
        });
      });
      if (di + BATCH < controlIds.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
    }
  }

  Logger.log('TM_buildFrameworkMaps_: built maps — ' +
    Object.keys(testFrameworkMap).length + ' test IDs (' + Object.keys(testNameMap).length + ' named), ' +
    Object.keys(docFrameworkMap).length + ' doc IDs (' + Object.keys(docNameMap).length + ' named)');

  return {
    testFrameworkMap: testFrameworkMap,
    docFrameworkMap:  docFrameworkMap,
    testNameMap:      testNameMap,
    docNameMap:       docNameMap
  };
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function TM_getOrCreateClientSheet_(clientName) {
  var ss    = WD_getClientDbSpreadsheet_();
  var name  = TM_CLIENT_SHEET_PREFIX + clientName;
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function TM_getOrCreateSheet_() {
  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(TM_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TM_SHEET_NAME);
    sheet.getRange(1, 1, 1, TM_COLS.length).setValues([TM_COLS]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 160);
    sheet.setColumnWidth(11, 200);
  }
  return sheet;
}

function TM_upsertClientRow_(clientName, summary) {
  var sheet   = TM_getOrCreateSheet_();
  var allData = sheet.getDataRange().getValues();
  var now     = new Date().toISOString();

  var newRow = [
    clientName,
    summary.frameworks       || '',
    summary.allTests         || 0,
    summary.scopedTests      || 0,
    summary.outTests         || 0,
    summary.deactivatedTests || 0,
    summary.allDocs          || 0,
    summary.scopedDocs       || 0,
    summary.outDocs          || 0,
    summary.deactivatedDocs  || 0,
    now
  ];

  var rowIdx = -1;
  for (var i = 1; i < allData.length; i++) {
    if (String(allData[i][0] || '').trim().toLowerCase() === clientName.trim().toLowerCase()) {
      rowIdx = i + 1;
      break;
    }
  }

  if (rowIdx === -1) sheet.appendRow(newRow);
  else sheet.getRange(rowIdx, 1, 1, newRow.length).setValues([newRow]);
}

/**
 * Recalculates summary metrics for a single client from its existing
 * "TM: ClientName" sheet — no Vanta API calls made.
 *
 * Useful after a cache rebuild (new framework maps) when you want to
 * re-scope already-fetched row data without a full API refresh.
 * Returns the summary object, or null if no per-client sheet exists.
 */
function TM_recalcClientFromSheet_(clientName) {
  var ss   = WD_getClientDbSpreadsheet_();
  var name = TM_CLIENT_SHEET_PREFIX + clientName;
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    Logger.log('TM_recalcClientFromSheet_: no sheet for ' + clientName);
    return null;
  }

  var meta        = WD_getClientMetadata(clientName);
  var storedFwStr = (meta.frameworks || '').trim();
  var summary     = TM_calculateMetricsFromSheet_(sheet, storedFwStr);

  TM_upsertClientRow_(clientName, summary);
  Logger.log('TM_recalcClientFromSheet_: [' + clientName + '] recalculated from sheet.');
  return summary;
}

// ── TMCache sheet helpers ──────────────────────────────────────────────────────

function TM_getOrCreateCacheSheet_() {
  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(TM_CACHE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TM_CACHE_SHEET_NAME);
    sheet.getRange(1, 1, 1, TM_CACHE_COLS.length).setValues([TM_CACHE_COLS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Reads cached framework maps for a client.
 * Returns null if missing, stale format (old TestIDs/DocIDs array format), or corrupt.
 */
function TM_readClientCache_(clientName) {
  var sheet = TM_getOrCreateCacheSheet_();
  var data  = sheet.getDataRange().getValues();
  var key   = clientName.trim().toLowerCase();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() !== key) continue;
    try {
      var testRaw = JSON.parse(String(data[i][2] || '{}'));
      var docRaw  = JSON.parse(String(data[i][3] || '{}'));

      // Invalidate old format (arrays, not objects)
      if (Array.isArray(testRaw) || Array.isArray(docRaw)) {
        Logger.log('TM_readClientCache_: old array format for ' + clientName + ', rebuilding.');
        return null;
      }

      return {
        frameworks:       String(data[i][1] || ''),
        testFrameworkMap: testRaw,
        docFrameworkMap:  docRaw,
        updatedAt:        data[i][4] ? String(data[i][4]) : null
      };
    } catch (e) {
      Logger.log('TM_readClientCache_: corrupt cache for ' + clientName + ', rebuilding.');
      return null;
    }
  }
  return null;
}

function TM_writeClientCache_(clientName, frameworks, testFrameworkMap, docFrameworkMap) {
  var sheet   = TM_getOrCreateCacheSheet_();
  var allData = sheet.getDataRange().getValues();
  var key     = clientName.trim().toLowerCase();
  var now     = new Date().toISOString();

  var newRow = [
    clientName,
    frameworks || '',
    JSON.stringify(testFrameworkMap || {}),
    JSON.stringify(docFrameworkMap  || {}),
    now
  ];

  var rowIdx = -1;
  for (var i = 1; i < allData.length; i++) {
    if (String(allData[i][0] || '').trim().toLowerCase() === key) {
      rowIdx = i + 1;
      break;
    }
  }

  if (rowIdx === -1) sheet.appendRow(newRow);
  else sheet.getRange(rowIdx, 1, 1, newRow.length).setValues([newRow]);
}

function TM_isCacheStale_(updatedAt) {
  if (!updatedAt) return true;
  try {
    return (new Date() - new Date(updatedAt)) / (1000 * 60 * 60 * 24) > TM_CACHE_MAX_AGE_DAYS;
  } catch (e) {
    return true;
  }
}

// ── Dev / editor test helpers ─────────────────────────────────────────────────
// Run these from the Apps Script editor (Run menu). Edit TEST_CLIENT_NAME first.

var TEST_CLIENT_NAME = 'Tenex'; // ← change to any active client name

function TEST_TM_Phase1() {
  Logger.log('=== Phase 1: ' + TEST_CLIENT_NAME + ' ===');
  var result = TM_refreshClientData(TEST_CLIENT_NAME);
  Logger.log(JSON.stringify(result, null, 2));
}

function TEST_TM_Phase2() {
  Logger.log('=== Phase 2: ' + TEST_CLIENT_NAME + ' ===');
  var result = TM_enrichClientFrameworks(TEST_CLIENT_NAME);
  Logger.log(result ? JSON.stringify(result, null, 2) : 'null (no frameworks or sheet)');
}

function TEST_TM_BothPhases() {
  Logger.log('=== Phase 1: ' + TEST_CLIENT_NAME + ' ===');
  var r1 = TM_refreshClientData(TEST_CLIENT_NAME);
  Logger.log(JSON.stringify(r1, null, 2));
  Logger.log('=== Phase 2: ' + TEST_CLIENT_NAME + ' ===');
  var r2 = TM_enrichClientFrameworks(TEST_CLIENT_NAME);
  Logger.log(r2 ? JSON.stringify(r2, null, 2) : 'null (no frameworks or sheet)');
}

/**
 * Force-rebuilds the TMCache for TEST_CLIENT_NAME and upserts into FrameworkMappingDB.
 * Run this once per client to seed the central DB (bypasses the 7-day cache check).
 * After running for all clients, FrameworkMappingDB will have the full cross-client picture.
 */
function TEST_FMDB_ForceRebuildAndUpsert() {
  Logger.log('=== Force rebuild + FrameworkMappingDB upsert: ' + TEST_CLIENT_NAME + ' ===');

  var meta        = WD_getClientMetadata(TEST_CLIENT_NAME);
  var storedFwStr = (meta.frameworks || '').trim();
  if (!storedFwStr) { Logger.log('No frameworks configured.'); return; }

  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(TM_CLIENT_SHEET_PREFIX + TEST_CLIENT_NAME);
  if (!sheet) { Logger.log('No TM: ' + TEST_CLIENT_NAME + ' sheet. Run Phase 1 first.'); return; }

  var token              = WD_getVantaAccessToken_(TEST_CLIENT_NAME);
  var resolvedFrameworks = TM_resolveFrameworks_(token, storedFwStr);
  if (!resolvedFrameworks.length) { Logger.log('Could not resolve frameworks.'); return; }

  var maps = TM_buildFrameworkMaps_(token, resolvedFrameworks);
  TM_writeClientCache_(TEST_CLIENT_NAME, storedFwStr, maps.testFrameworkMap, maps.docFrameworkMap);
  Logger.log('Cache written.');

  // Supplement docNameMap from TM: sheet before upsert
  TM_supplementDocNames_(maps.docNameMap, sheet);
  Logger.log('docNameMap after supplement: ' + Object.keys(maps.docNameMap).length + ' names, ' +
    Object.keys(maps.docFrameworkMap).length + ' doc IDs in framework map.');

  FMDB_upsertFromMaps_(maps.testFrameworkMap, maps.docFrameworkMap, maps.testNameMap, maps.docNameMap, sheet);
  Logger.log('FrameworkMappingDB upserted. Run TEST_FMDB_Inspect() to view results.');
}

/**
 * Diagnoses why frameworks aren't being filled for a client.
 * Logs: stored framework string, Vanta frameworks, resolved IDs, map sizes,
 * and a sample of sheet IDs vs map IDs to catch mismatches.
 * Run from Apps Script editor — does NOT write anything.
 */
function TEST_TM_DiagnoseFrameworks() {
  Logger.log('=== Diagnose Frameworks: ' + TEST_CLIENT_NAME + ' ===');

  // 1. Check stored frameworks
  var meta = WD_getClientMetadata(TEST_CLIENT_NAME);
  var storedFwStr = (meta.frameworks || '').trim();
  Logger.log('Stored frameworks in ClientDB: "' + storedFwStr + '"');
  if (!storedFwStr) {
    Logger.log('ISSUE: No frameworks configured for this client. Set them in Client Management.');
    return;
  }

  // 2. Resolve Vanta frameworks (logs available names internally)
  var token = WD_getVantaAccessToken_(TEST_CLIENT_NAME);
  var resolved = TM_resolveFrameworks_(token, storedFwStr);
  if (!resolved.length) {
    Logger.log('ISSUE: None of the stored framework names matched Vanta. See names logged above.');
    return;
  }

  // 3. Build maps
  var maps = TM_buildFrameworkMaps_(token, resolved);
  Logger.log('Test framework map: ' + Object.keys(maps.testFrameworkMap).length + ' IDs');
  Logger.log('Doc  framework map: ' + Object.keys(maps.docFrameworkMap).length + ' IDs');
  if (!Object.keys(maps.testFrameworkMap).length && !Object.keys(maps.docFrameworkMap).length) {
    Logger.log('ISSUE: Maps are empty. Controls may have no tests/docs, or endpoint returned 0 items.');
    return;
  }

  // 4. Compare against existing sheet
  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(TM_CLIENT_SHEET_PREFIX + TEST_CLIENT_NAME);
  if (!sheet) {
    Logger.log('ISSUE: No TM: ' + TEST_CLIENT_NAME + ' sheet. Run Phase 1 first.');
    return;
  }

  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol   = hdr.indexOf('id');
  var typeCol = hdr.indexOf('type');

  var testIds = [], docIds = [];
  for (var i = 1; i < data.length; i++) {
    var t = String(data[i][typeCol] || '').trim();
    var id = String(data[i][idCol] || '').trim();
    if (!id) continue;
    if (t === 'Automated Test') testIds.push(id);
    else if (t === 'Documents') docIds.push(id);
  }

  var testMatches = testIds.filter(function(id) { return maps.testFrameworkMap[id]; }).length;
  var docMatches  = docIds.filter(function(id) { return maps.docFrameworkMap[id]; }).length;

  Logger.log('Sheet has ' + testIds.length + ' tests, ' + docIds.length + ' docs');
  Logger.log('Matched: ' + testMatches + ' tests, ' + docMatches + ' docs');
  Logger.log('Sheet test ID sample: ' + JSON.stringify(testIds.slice(0, 3)));
  Logger.log('Map   test ID sample: ' + JSON.stringify(Object.keys(maps.testFrameworkMap).slice(0, 3)));
  Logger.log('Sheet doc  ID sample: ' + JSON.stringify(docIds.slice(0, 3)));
  Logger.log('Map   doc  ID sample: ' + JSON.stringify(Object.keys(maps.docFrameworkMap).slice(0, 3)));

  if (!testMatches && !docMatches) {
    Logger.log('ISSUE: IDs in sheet do not match IDs in framework map. Likely an ID field mismatch between /tests and /controls/{id}/tests endpoints.');
  } else {
    Logger.log('OK: Framework maps look correct. Run TEST_TM_Phase2() to apply.');
  }
}
