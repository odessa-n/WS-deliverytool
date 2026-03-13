/** TestMonitor.gs **/

var TM_SHEET_NAME = 'Test Monitor';
var TM_LAST_REFRESH_KEY = 'TM_LAST_REFRESH';
var TM_COLS = ['Client', 'Frameworks', 'Outstanding Tests', 'Total Tests', 'Outstanding Docs', 'Total Docs', 'Updated At'];

// ── Public API (called from frontend) ────────────────────────────────────────

/**
 * Returns cached test monitor data from the DB sheet.
 * No Vanta API calls — safe to call on page load.
 */
function TM_getTestMonitorData() {
  var sheet = TM_getOrCreateSheet_();
  var rows = sheet.getDataRange().getValues();
  var lastRefresh = PropertiesService.getScriptProperties().getProperty(TM_LAST_REFRESH_KEY) || null;

  if (rows.length < 2) {
    return { rows: [], lastRefresh: lastRefresh };
  }

  // Merge live DB framework values — handles rows cached before frameworks were stored
  var dbMap = WD_readAllClientDb_();

  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!String(row[0] || '').trim()) continue;

    var clientName    = String(row[0] || '').trim();
    var dbEntry       = dbMap[clientName.toLowerCase()] || {};

    // Skip inactive clients — excluded from Test Monitoring display
    if ((dbEntry.clientStatus || 'Active').trim().toLowerCase() === 'inactive') continue;

    var frameworks    = (dbEntry.frameworks || String(row[1] || '')).trim();
    var outTests      = Number(row[2]) || 0;
    var totalTests    = Number(row[3]) || 0;
    var outDocs       = Number(row[4]) || 0;
    var totalDocs     = Number(row[5]) || 0;
    var updatedAt     = row[6] ? String(row[6]) : null;

    var testPct       = totalTests > 0 ? Math.round((totalTests - outTests) / totalTests * 100) : 0;
    var docPct        = totalDocs  > 0 ? Math.round((totalDocs  - outDocs)  / totalDocs  * 100) : 0;
    var totalOut      = outTests + outDocs;
    var totalScope    = totalTests + totalDocs;
    var completedPct  = totalScope > 0 ? Math.round((totalScope - totalOut) / totalScope * 100) : 0;

    data.push({
      clientName:    clientName,
      frameworks:    frameworks,
      outTests:      outTests,
      totalTests:    totalTests,
      testPct:       testPct,
      outDocs:       outDocs,
      totalDocs:     totalDocs,
      docPct:        docPct,
      totalOut:      totalOut,
      totalScope:    totalScope,
      completedPct:  completedPct,
      updatedAt:     updatedAt
    });
  }

  return { rows: data, lastRefresh: lastRefresh };
}

/**
 * Pulls fresh data from Vanta for a specific subset of clients.
 * Called by the "Refresh Selected" button.
 * Returns the updated full dataset (same shape as TM_refreshAllClients).
 */
function TM_refreshSelectedClients(clientNames) {
  if (!clientNames || !clientNames.length) {
    throw new Error('No clients provided.');
  }

  var errors = [];
  var successCount = 0;

  clientNames.forEach(function(clientName) {
    try {
      var summary = TM_fetchClientTestSummary_(clientName);
      TM_upsertClientRow_(clientName, summary);
      successCount++;
    } catch (e) {
      errors.push(clientName + ': ' + e.message);
      Logger.log('TM refresh error [' + clientName + ']: ' + e.toString());
    }
  });

  var now = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(TM_LAST_REFRESH_KEY, now);

  var result = TM_getTestMonitorData();
  result.refreshedCount = successCount;
  result.totalClients   = clientNames.length;
  result.errors         = errors;
  return result;
}

/**
 * Pulls fresh data from Vanta for all clients and stores in the DB sheet.
 * Called by the manual Refresh button and the scheduled trigger.
 * Returns the updated dataset and a summary of the run.
 */
function TM_refreshAllClients() {
  var clients;
  try {
    clients = WD_getActiveClients();
  } catch (e) {
    throw new Error('Could not load client list: ' + e.message);
  }

  if (!clients || !clients.length) {
    throw new Error('No clients found to refresh.');
  }

  var errors = [];
  var successCount = 0;

  clients.forEach(function(clientName) {
    try {
      var summary = TM_fetchClientTestSummary_(clientName);
      TM_upsertClientRow_(clientName, summary);
      successCount++;
    } catch (e) {
      errors.push(clientName + ': ' + e.message);
      Logger.log('TM refresh error [' + clientName + ']: ' + e.toString());
    }
  });

  var now = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(TM_LAST_REFRESH_KEY, now);

  var result = TM_getTestMonitorData();
  result.refreshedCount = successCount;
  result.totalClients   = clients.length;
  result.errors         = errors;
  return result;
}

// ── Scheduled trigger ─────────────────────────────────────────────────────────

/**
 * Called by the time-based triggers (6 AM and 12 PM EST).
 * Failures are logged but do not surface as errors.
 */
function TM_scheduledRefresh_() {
  try {
    TM_refreshAllClients();
  } catch (e) {
    Logger.log('TM_scheduledRefresh_ error: ' + e.toString());
  }
}

/**
 * Creates two daily triggers: approximately 6 AM and 12 PM EST.
 *
 * Script timezone is Asia/Manila (UTC+8).
 *   6 AM  EST (UTC-5) = 19:00 Manila
 *   12 PM EST (UTC-5) = 01:00 Manila (next day)
 *
 * Note: During EDT (UTC-4) these fire ~1 hour early.
 * Run this ONCE from the Apps Script editor, then leave it.
 */
function TM_setupTriggers() {
  // Remove any existing TM triggers first to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'TM_scheduledRefresh_') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 6 AM EST → 7 PM Manila (hour 19)
  ScriptApp.newTrigger('TM_scheduledRefresh_')
    .timeBased()
    .atHour(19)
    .everyDays(1)
    .create();

  // 12 PM EST → 1 AM Manila (hour 1)
  ScriptApp.newTrigger('TM_scheduledRefresh_')
    .timeBased()
    .atHour(1)
    .everyDays(1)
    .create();

  Logger.log('TM triggers created: 7 PM and 1 AM Manila (≈ 6 AM and 12 PM EST).');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Fetches test + document summary for one client from Vanta,
 * scoped to the framework(s) stored in ClientDB.
 *
 * Framework name matching mirrors the Trust Ops multi-select logic:
 * stored names are split by comma, trimmed, and compared case-insensitively
 * against the Vanta framework name field.
 */
function TM_fetchClientTestSummary_(clientName) {
  var token = WD_getVantaAccessToken_(clientName);

  // Resolve stored framework names → Vanta framework IDs
  var meta           = WD_getClientMetadata(clientName);
  var storedFwStr    = meta.frameworks || '';
  var frameworkIds   = TM_resolveFrameworkIds_(token, storedFwStr);

  // Always fetch the full test list (needed for both scoped and unscoped paths)
  var allTests = WD_fetchAllTests_(token);

  var totalTests, outTests, totalDocs, outDocs;

  if (frameworkIds.length) {
    // ── Framework-scoped path ──────────────────────────────────────────────
    // Traverse framework → controls → test IDs / document IDs once,
    // then use those ID sets to filter counts (same pattern as Trust Ops v2.A).
    var controlIds    = WD_fetchControlIdsForFrameworks_(token, frameworkIds);
    var inScopeTestIds = WD_fetchTestIdsForControls_(token, controlIds);
    var inScopeDocIds  = WD_fetchDocumentIdsForControls_(token, controlIds);

    // Scoped tests
    var scopedTests = allTests.filter(function(t) {
      return !!inScopeTestIds[String(t.id || t.testId || '')];
    });
    totalTests = scopedTests.length;
    outTests   = 0;
    scopedTests.forEach(function(t) {
      if (WD_mapTestRecord_(t).normalizedStatus === 'Outstanding') outTests++;
    });

    // Scoped documents — total is the size of the in-scope ID set;
    // outstanding is the subset returned by the outstanding-docs endpoint.
    totalDocs = Object.keys(inScopeDocIds).length;
    var allOutDocs = WD_fetchAllDocuments_(token);
    outDocs = allOutDocs.filter(function(d) {
      return !!inScopeDocIds[String(d.id || d.documentId || '')];
    }).length;

  } else {
    // ── Unscoped path (no framework stored yet) ────────────────────────────
    totalTests = allTests.length;
    outTests   = 0;
    allTests.forEach(function(t) {
      if (WD_mapTestRecord_(t).normalizedStatus === 'Outstanding') outTests++;
    });
    totalDocs = TM_countAllDocuments_(token);
    outDocs   = WD_fetchAllDocuments_(token).length;
  }

  return {
    frameworks: storedFwStr,
    outTests:   outTests,
    totalTests: totalTests,
    outDocs:    outDocs,
    totalDocs:  totalDocs
  };
}

/**
 * Resolves stored framework name string → array of Vanta framework IDs.
 * Names are comma-separated and matched case-insensitively against Vanta.
 * Returns [] if storedFwStr is blank or no matches are found.
 */
function TM_resolveFrameworkIds_(token, storedFwStr) {
  if (!storedFwStr || !storedFwStr.trim()) return [];

  var storedNames = storedFwStr.split(',').reduce(function(acc, n) {
    var key = n.trim().toLowerCase();
    if (key) acc[key] = true;
    return acc;
  }, {});

  var allFrameworks = WD_fetchFrameworks_(token);
  var ids = [];
  allFrameworks.forEach(function(fw) {
    // Mirror the name resolution in WD_getFrameworks: name || displayName || id
    var fwName = (fw.name || fw.displayName || fw.id || '').trim().toLowerCase();
    if (fwName && storedNames[fwName]) {
      ids.push(fw.id);
    }
  });
  return ids;
}

/**
 * Counts total documents for a client across all statuses.
 * Used only when no framework scope is available.
 */
function TM_countAllDocuments_(token) {
  var headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  var count  = 0;
  var cursor = null;

  do {
    var url = APP_CONFIG.VANTA_API_BASE + '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);

    var body    = WD_fetchJsonWithRetry_({ url: url, method: 'get', options: { headers: headers } });
    var results = body.results || {};
    var data    = results.data || [];
    count      += data.length;

    var pageInfo = results.pageInfo || {};
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
  } while (cursor);

  return count;
}

/**
 * Upserts (insert or update) a client row in the Test Monitor sheet.
 */
function TM_upsertClientRow_(clientName, summary) {
  var sheet   = TM_getOrCreateSheet_();
  var allData = sheet.getDataRange().getValues();
  var now     = new Date().toISOString();

  var newRow = [
    clientName,
    summary.frameworks || '',
    summary.outTests   || 0,
    summary.totalTests || 0,
    summary.outDocs    || 0,
    summary.totalDocs  || 0,
    now
  ];

  // Find existing row (skip header at index 0)
  var rowIdx = -1;
  for (var i = 1; i < allData.length; i++) {
    if (String(allData[i][0] || '').trim().toLowerCase() === clientName.trim().toLowerCase()) {
      rowIdx = i + 1; // 1-based sheet row
      break;
    }
  }

  if (rowIdx === -1) {
    sheet.appendRow(newRow);
  } else {
    sheet.getRange(rowIdx, 1, 1, newRow.length).setValues([newRow]);
  }
}

/**
 * Returns the Test Monitor sheet, creating it with headers if it doesn't exist.
 */
function TM_getOrCreateSheet_() {
  var ss    = SpreadsheetApp.openById(APP_CONFIG.CLIENT_DB_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(TM_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TM_SHEET_NAME);
    sheet.getRange(1, 1, 1, TM_COLS.length).setValues([TM_COLS]);
    sheet.setFrozenRows(1);
    // Basic column width formatting
    sheet.setColumnWidth(1, 180); // Client
    sheet.setColumnWidth(2, 140); // Frameworks
  }

  return sheet;
}
