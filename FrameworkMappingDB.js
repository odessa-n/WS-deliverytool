/** FrameworkMappingDB.gs **/

/**
 * FrameworkMappingDB — Central registry of every test & document mapped to
 * compliance frameworks via Vanta control traversal.
 *
 * ── SHEET ─────────────────────────────────────────────────────────────────────
 * Tab: "FrameworkMappingDB" in CLIENT_DB_SPREADSHEET_ID
 *
 *   id  |  name  |  type  |  category  |  SOC 2  |  ISO 27001  |  …  |  updatedAt
 *
 * Framework columns are added dynamically as new frameworks are synced.
 * SOC 2 and ISO 27001 are sorted to the front; all others follow alphabetically.
 * When an item is mapped to a framework, the cell stores the framework name.
 * When not mapped, it stores — (em dash).
 *
 * ── KEY STRATEGY ──────────────────────────────────────────────────────────────
 * Primary key:  id + type   (Vanta ID from the API traversal)
 * Fallback key: name + type (upgrades legacy name-only rows on re-upsert)
 *
 * ── ACCUMULATION ─────────────────────────────────────────────────────────────
 * Framework flags are additive — existing flags are never cleared.
 * New items found in any sync run are appended; existing rows are merged.
 */

var FMDB_SHEET_NAME  = 'FrameworkMappingDB';
var FMDB_FIXED_LEAD  = ['id', 'name', 'type', 'category'];
var FMDB_FIXED_TRAIL = ['updatedAt'];
var FMDB_DASH        = '\u2014'; // —  "not mapped to this framework"

// Framework columns are sorted with these names first (in this order)
var FMDB_FW_PRIORITY = ['SOC 2', 'ISO 27001', 'ISO 27001:2022', 'HIPAA', 'PCI DSS', 'NIST CSF', 'NIST 800-53'];

// Pacing to avoid Vanta "Bandwidth quota exceeded" (longer than global RATE_LIMIT_MIN_MS)
var FMDB_RATE_LIMIT_MS = 1200;
var FMDB_BATCH_SIZE   = 10;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Sync tests and documents for one or all frameworks into FrameworkMappingDB.
 * Traverses: framework → controls → tests + documents (batched, 20 at a time).
 * Upserts into the sheet so each id+type has exactly one row.
 *
 * @param {Object} payload
 *   clientName    {string}  Required.
 *   frameworkId   {string}  Optional. Sync only this framework.
 *   frameworkName {string}  Required when frameworkId is provided.
 * @returns {Object} { added, updated, total, frameworks: string[], syncedAt }
 */
function WD_syncFrameworkMappingDB(payload) {
  payload = payload || {};
  var clientName    = String(payload.clientName    || '').trim();
  var frameworkId   = String(payload.frameworkId   || '').trim();
  var frameworkName = String(payload.frameworkName || '').trim();

  if (!clientName) throw new Error('clientName is required.');
  if (frameworkId && !frameworkName) throw new Error('frameworkName is required when frameworkId is provided.');

  var token = WD_getVantaAccessToken_(clientName);

  // Build list of { id, name } to process (include all frameworks in the instance, not only in-scope)
  var frameworksToSync = [];
  if (frameworkId) {
    frameworksToSync.push({ id: frameworkId, name: frameworkName });
  } else {
    var allFrameworks = WD_fetchFrameworks_(token, true);
    allFrameworks.forEach(function(f) {
      var fId   = String(f.id || '').trim();
      var fName = String(f.name || f.displayName || f.id || '').trim();
      if (fId && fName) frameworksToSync.push({ id: fId, name: fName });
    });
  }

  if (!frameworksToSync.length) {
    return { added: 0, updated: 0, total: 0, frameworks: [], syncedAt: new Date().toISOString() };
  }

  // byId accumulator: { "id|type" → { id, name, type, category, frameworks:{fwName:true} } }
  var byId = {};

  for (var f = 0; f < frameworksToSync.length; f++) {
    if (f > 0) Utilities.sleep(FMDB_RATE_LIMIT_MS);
    var fw = frameworksToSync[f];
    FMDB_traverseFramework_(token, fw.id, fw.name, byId);
  }

  var sheet  = FMDB_getOrCreateSheet_();
  var result = FMDB_batchUpsert_(sheet, byId);

  Logger.log('WD_syncFrameworkMappingDB: client=' + clientName +
    ' frameworks=[' + frameworksToSync.map(function(f) { return f.name; }).join(', ') + ']' +
    ' added=' + result.added + ' updated=' + result.updated + ' total=' + result.total);

  return {
    added:      result.added,
    updated:    result.updated,
    total:      result.total,
    frameworks: frameworksToSync.map(function(f) { return f.name; }),
    syncedAt:   new Date().toISOString()
  };
}

/**
 * Syncs FrameworkMappingDB from an already-fetched doc map (controls with tests and documents).
 * Use this after WD_getFrameworkDocMap so the same API response feeds both the UI and the DB,
 * avoiding duplicate API calls and bandwidth quota errors. Ensures documents are written to the DB.
 *
 * @param {Object} payload
 *   clientName    {string}  Required (for audit/logging).
 *   frameworkName {string}  Required. Framework column name (e.g. "ISO 27001:2022").
 *   controls      {Array}   Required. From doc map: [{ id, name, category?, tests: [{id,name}], documents: [{id,name,type?}] }]
 * @returns {Object} { added, updated, total, frameworks: string[], syncedAt }
 */
function WD_syncFrameworkMappingDBFromDocMap(payload) {
  payload = payload || {};
  var clientName   = String(payload.clientName   || '').trim();
  var frameworkName = String(payload.frameworkName || '').trim();
  var controls     = payload.controls;

  if (!frameworkName) throw new Error('frameworkName is required.');
  if (!Array.isArray(controls)) controls = [];

  var byId = {};
  for (var c = 0; c < controls.length; c++) {
    var ctrl = controls[c];
    var category = String(ctrl.category || '').trim();

    var tests = ctrl.tests || [];
    for (var t = 0; t < tests.length; t++) {
      var test = tests[t];
      var tid = String(test.id || '').trim();
      var tname = String(test.name || test.displayName || test.id || '').trim();
      if (!tid && !tname) continue;
      FMDB_mergeItem_(byId, {
        id:            tid,
        name:          tname,
        type:          'Automated Test',
        category:      category,
        frameworkName: frameworkName
      });
    }

    var docs = ctrl.documents || [];
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      var did = String(doc.id || doc.documentId || '').trim();
      var dname = String(doc.name || doc.title || doc.displayName || doc.id || doc.documentId || '').trim();
      if (!did && !dname) continue;
      FMDB_mergeItem_(byId, {
        id:            did,
        name:          dname,
        type:          'Document',
        category:      String(doc.type || doc.category || '').trim(),
        frameworkName: frameworkName
      });
    }
  }

  var sheet  = FMDB_getOrCreateSheet_();
  var result = FMDB_batchUpsert_(sheet, byId);

  Logger.log('WD_syncFrameworkMappingDBFromDocMap: client=' + clientName +
    ' framework=' + frameworkName + ' added=' + result.added + ' updated=' + result.updated + ' total=' + result.total);

  return {
    added:      result.added,
    updated:    result.updated,
    total:      result.total,
    frameworks: [frameworkName],
    syncedAt:   new Date().toISOString()
  };
}

/**
 * Syncs FrameworkMappingDB for every client (all frameworks per client).
 * Use from the Framework Mapping menu to refresh the central DB.
 *
 * @returns {{ synced: Array<{ clientName, added, updated, total }>, errors: Array<{ clientName, message }>, lastSyncedAt: string }}
 */
function WD_syncFrameworkMappingDBAllClients() {
  if (!isAdmin()) {
    throw new Error('Only admins can run Fetch for all clients. Set ADMIN_EMAILS in Script Properties.');
  }
  var clients = [];
  try {
    clients = WD_getClients();
  } catch (e) {
    return { synced: [], errors: [{ clientName: '', message: (e && e.message) || String(e) }], lastSyncedAt: '' };
  }
  var synced = [];
  var errors = [];
  var lastSyncedAt = new Date().toISOString();

  for (var i = 0; i < clients.length; i++) {
    var clientName = typeof clients[i] === 'string' ? clients[i] : (clients[i].name || clients[i].clientName || '');
    if (!clientName) continue;
    try {
      var result = WD_syncFrameworkMappingDB({ clientName: clientName });
      synced.push({
        clientName: clientName,
        added:      result.added,
        updated:    result.updated,
        total:      result.total
      });
    } catch (e) {
      errors.push({ clientName: clientName, message: (e && e.message) || String(e) });
    }
  }
  WD_appendAuditLog_('Sync FrameworkMappingDB (all clients)', 'clients=' + synced.length + ' errors=' + errors.length);

  return { synced: synced, errors: errors, lastSyncedAt: lastSyncedAt };
}

/**
 * Returns all rows in FrameworkMappingDB as an array of objects.
 * Each object: { id, name, type, category, updatedAt, frameworks: { fwName: bool } }
 */
function WD_getFrameworkMappingDB() {
  var out = WD_getFrameworkMappingDBWithMeta_();
  return out.rows;
}

/**
 * Returns FrameworkMappingDB rows plus metadata for the UI.
 * @returns {{ rows: Array, lastUpdated: string, frameworkColumns: string[] }}
 */
function WD_getFrameworkMappingDBForUI() {
  var out = WD_getFrameworkMappingDBWithMeta_();
  return {
    rows:              out.rows,
    lastUpdated:       out.lastUpdated,
    frameworkColumns:  out.frameworkColumns
  };
}

function WD_getFrameworkMappingDBWithMeta_() {
  var sheet = FMDB_getOrCreateSheet_();
  var data  = sheet.getDataRange().getValues();
  var fixedAll = FMDB_FIXED_LEAD.concat(FMDB_FIXED_TRAIL).map(function(h) { return h.toLowerCase(); });
  var result = { rows: [], lastUpdated: '', frameworkColumns: [] };
  if (data.length < 2) return result;

  var headers  = data[0].map(function(h) { return String(h).trim(); });
  var hdrLow   = headers.map(function(h) { return h.toLowerCase(); });
  var fwCols   = headers.filter(function(h) { return fixedAll.indexOf(h.toLowerCase()) < 0; });
  result.frameworkColumns = fwCols;

  var iId  = hdrLow.indexOf('id');
  var iNm  = hdrLow.indexOf('name');
  var iTy  = hdrLow.indexOf('type');
  var iCat = hdrLow.indexOf('category');
  var iUpd = hdrLow.indexOf('updatedat');

  var lastUpdated = '';
  result.rows = data.slice(1).filter(function(row) {
    return (iId >= 0 && String(row[iId] || '').trim()) ||
           (iNm >= 0 && String(row[iNm] || '').trim());
  }).map(function(row) {
    var upd = iUpd >= 0 ? String(row[iUpd] || '').trim() : '';
    if (upd && (!lastUpdated || upd > lastUpdated)) lastUpdated = upd;
    var obj = {
      id:        iId  >= 0 ? String(row[iId]  || '').trim() : '',
      name:      iNm  >= 0 ? String(row[iNm]  || '').trim() : '',
      type:      iTy  >= 0 ? String(row[iTy]  || '').trim() : '',
      category:  iCat >= 0 ? String(row[iCat] || '').trim() : '',
      updatedAt: upd,
      frameworks: {}
    };
    fwCols.forEach(function(fw) {
      var ci  = hdrLow.indexOf(fw.toLowerCase());
      var val = ci >= 0 ? String(row[ci] || '').trim() : '';
      obj.frameworks[fw] = (val && val !== FMDB_DASH);
    });
    return obj;
  });
  result.lastUpdated = lastUpdated;
  return result;
}

/**
 * Upserts framework mappings from Test Monitor Phase-2 maps into FrameworkMappingDB.
 * Uses type "Document" (singular) for documents. Call FMDB_batchUpsert_ for the single sheet.
 *
 * @param {Object} testFrameworkMap  { id: "fw1, fw2" }
 * @param {Object} docFrameworkMap   { id: "fw1" }
 * @param {Object} testNameMap       { id: "test display name" }
 * @param {Object} docNameMap        { id: "doc display name" }
 * @param {Sheet}  clientSheet       TM: ClientName sheet — fallback id→name source
 */
function FMDB_upsertFromMaps_(testFrameworkMap, docFrameworkMap, testNameMap, docNameMap, clientSheet) {
  testNameMap = testNameMap || {};
  docNameMap  = docNameMap  || {};
  var idMeta = clientSheet ? FMDB_readIdMeta_(clientSheet) : {};
  var byId = {};

  function addEntry(id, frameworksStr, type, nameMap) {
    if (!id) return;
    var name = (nameMap[id] || '').trim();
    if (!name && idMeta[id]) name = (idMeta[id].name || '').trim();
    if (!name) return;
    var category = (idMeta[id] && idMeta[id].category) || '';
    var key = id + '|' + type.toLowerCase();
    if (!byId[key]) {
      byId[key] = { id: id, name: name, type: type, category: category, frameworks: {} };
    } else {
      if (!byId[key].name && name) byId[key].name = name;
      if (!byId[key].category && category) byId[key].category = category;
    }
    (frameworksStr || '').split(',').forEach(function(fw) {
      fw = fw.trim();
      if (fw) byId[key].frameworks[fw] = true;
    });
  }

  Object.keys(testFrameworkMap || {}).forEach(function(id) {
    addEntry(id, testFrameworkMap[id], 'Automated Test', testNameMap);
  });
  Object.keys(docFrameworkMap || {}).forEach(function(id) {
    addEntry(id, docFrameworkMap[id], 'Document', docNameMap);
  });

  var entryCount = Object.keys(byId).length;
  if (!entryCount) {
    Logger.log('FMDB_upsertFromMaps_: nothing to upsert.');
    return;
  }
  var sheet = FMDB_getOrCreateSheet_();
  FMDB_batchUpsert_(sheet, byId);
}

/**
 * Returns id-keyed and name-keyed scoping maps for the given client frameworks.
 * Reads FrameworkMappingDB; treats type "Document" or "Documents" as document (backward compat).
 *
 * @param  {string[]} clientFrameworks  e.g. ["SOC 2", "HIPAA"]
 * @return {{ testsById, docsById, testsByName, docsByName }}
 */
function FMDB_buildScopingMaps_(clientFrameworks) {
  var testsById   = {};
  var docsById    = {};
  var testsByName = {};
  var docsByName  = {};
  var empty = { testsById: testsById, docsById: docsById, testsByName: testsByName, docsByName: docsByName };
  if (!clientFrameworks || !clientFrameworks.length) return empty;

  var sheet = FMDB_getOrCreateSheet_();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return empty;

  var headers  = data[0].map(function(h) { return String(h).trim(); });
  var hdrLower = headers.map(function(h) { return h.toLowerCase(); });
  var idCol    = hdrLower.indexOf('id');
  var nameCol  = hdrLower.indexOf('name');
  var typeCol  = hdrLower.indexOf('type');
  if (nameCol < 0 || typeCol < 0) return empty;

  var clientFwsNorm = clientFrameworks.map(function(fw) { return fw.trim().toLowerCase(); });
  var matchingFwCols = [];
  headers.forEach(function(h, ci) {
    var hL = h.toLowerCase();
    if (ci === idCol || ci === nameCol || ci === typeCol || hL === 'category' || hL === 'updatedat') return;
    for (var fi = 0; fi < clientFwsNorm.length; fi++) {
      var stored = clientFwsNorm[fi];
      if (hL === stored || hL.indexOf(stored) >= 0 || stored.indexOf(hL) >= 0) {
        matchingFwCols.push({ idx: ci, name: h });
        break;
      }
    }
  });
  if (!matchingFwCols.length) return empty;

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var id   = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    var name = String(row[nameCol] || '').trim();
    var type = String(row[typeCol] || '').trim();
    if (!name || !type) continue;
    var matchedFws = [];
    matchingFwCols.forEach(function(fc) {
      var val = String(row[fc.idx] || '').trim();
      if (val && val !== FMDB_DASH) matchedFws.push(fc.name);
    });
    if (!matchedFws.length) continue;
    var fwStr   = matchedFws.join(', ');
    var nameKey = name.toLowerCase();
    if (type === 'Automated Test') {
      if (id) testsById[id] = fwStr;
      testsByName[nameKey] = fwStr;
    } else if (type === 'Document' || type === 'Documents') {
      if (id) docsById[id] = fwStr;
      docsByName[nameKey] = fwStr;
    }
  }
  return { testsById: testsById, docsById: docsById, testsByName: testsByName, docsByName: docsByName };
}

/**
 * Updates the framework and Scoped columns in a per-client TM: sheet.
 * TM: sheet uses type "Documents"; lookup order ID first then name.
 *
 * @param {Sheet}  sheet   TM: ClientName sheet
 * @param {Object} maps    { testsById, docsById, testsByName, docsByName }
 */
function FMDB_updateSheetScoping_(sheet, maps) {
  var testsById   = maps.testsById   || {};
  var docsById    = maps.docsById    || {};
  var testsByName = maps.testsByName || {};
  var docsByName  = maps.docsByName  || {};
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return;

  var hdr     = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol   = hdr.indexOf('id');
  var nameCol = hdr.indexOf('name');
  var typeCol = hdr.indexOf('type');
  var fwCol   = hdr.indexOf('framework');
  var scCol   = hdr.indexOf('scoped');
  if (nameCol < 0 || typeCol < 0 || fwCol < 0 || scCol < 0) return;

  for (var i = 1; i < data.length; i++) {
    var id   = idCol >= 0 ? String(data[i][idCol] || '').trim() : '';
    var name = String(data[i][nameCol] || '').trim();
    var type = String(data[i][typeCol] || '').trim();
    if (!name || !type) continue;
    var nameKey = name.toLowerCase();
    var fwStr;
    if (type === 'Automated Test') {
      fwStr = (id && testsById[id]) ? testsById[id] : (testsByName[nameKey] || '');
    } else if (type === 'Documents') {
      fwStr = (id && docsById[id]) ? docsById[id] : (docsByName[nameKey] || '');
    } else {
      continue;
    }
    data[i][fwCol] = fwStr;
    data[i][scCol] = fwStr ? 'Yes' : 'No';
  }
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}

/**
 * Reads the per-client TM: sheet → { id: { name, type, category } }.
 */
function FMDB_readIdMeta_(clientSheet) {
  var result = {};
  if (!clientSheet) return result;
  var data = clientSheet.getDataRange().getValues();
  if (data.length < 2) return result;

  var hdr     = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idCol   = hdr.indexOf('id');
  var nameCol = hdr.indexOf('name');
  var typeCol = hdr.indexOf('type');
  var catCol  = hdr.indexOf('category');
  if (idCol < 0 || nameCol < 0) return result;

  for (var i = 1; i < data.length; i++) {
    var id   = String(data[i][idCol] || '').trim();
    var name = String(data[i][nameCol] || '').trim();
    if (!id || !name) continue;
    result[id] = {
      name:     name,
      type:     typeCol >= 0 ? String(data[i][typeCol] || '').trim() : '',
      category: catCol >= 0 ? String(data[i][catCol] || '').trim() : ''
    };
  }
  return result;
}

// ── Internal: traversal ────────────────────────────────────────────────────────

/**
 * Fetches all controls for a framework, then for each control fetches all pages of
 * tests and documents (via WD_fetchControlTests_ / WD_fetchControlDocuments_) so
 * every test and document mapped to that framework is included, not just the first page.
 * Merges every item into byId.
 *
 * @param {string} token
 * @param {string} frameworkId
 * @param {string} frameworkName  Column header / flag value.
 * @param {Object} byId           Shared accumulator, mutated in place.
 */
function FMDB_traverseFramework_(token, frameworkId, frameworkName, byId) {
  Utilities.sleep(FMDB_RATE_LIMIT_MS);
  var controls = WD_fetchFrameworkControls_(token, frameworkId);
  if (!controls.length) {
    Logger.log('FMDB_traverseFramework_: no controls for framework ' + frameworkId);
    return;
  }

  for (var i = 0; i < controls.length; i++) {
    var ctrl = controls[i];
    if (i > 0) Utilities.sleep(FMDB_RATE_LIMIT_MS);

    // All pages of tests for this control (not just first page)
    var allTests = WD_fetchControlTests_(token, ctrl.id);
    allTests.forEach(function(t) {
      FMDB_mergeItem_(byId, {
        id:            String(t.id || t.testId || '').trim(),
        name:          String(t.name || t.displayName || t.id || t.testId || '').trim(),
        type:          'Automated Test',
        category:      String(t.category || ctrl.category || '').trim(),
        frameworkName: frameworkName
      });
    });

    Utilities.sleep(FMDB_RATE_LIMIT_MS);

    // All pages of documents for this control (not just first page)
    var allDocs = WD_fetchControlDocuments_(token, ctrl.id);
    allDocs.forEach(function(d) {
      var docId   = String(d.id || d.documentId || '').trim();
      var docName = String(d.name || d.title || d.displayName || d.id || d.documentId || '').trim();
      if (!docId && !docName) return;
      FMDB_mergeItem_(byId, {
        id:            docId,
        name:          docName,
        type:          'Document',
        category:      String(d.type || d.category || '').trim(),
        frameworkName: frameworkName
      });
    });
  }
}

/**
 * Upsert a single item into the byId accumulator.
 * Key: (id || name) + "|" + type.
 */
function FMDB_mergeItem_(byId, item) {
  if (!item.id && !item.name) return;
  var typeKey = item.type.toLowerCase();
  var key     = (item.id || item.name) + '|' + typeKey;

  if (!byId[key]) {
    byId[key] = {
      id:         item.id,
      name:       item.name,
      type:       item.type,
      category:   item.category,
      frameworks: {}
    };
  } else {
    if (!byId[key].id       && item.id)       byId[key].id       = item.id;
    if (!byId[key].name     && item.name)     byId[key].name     = item.name;
    if (!byId[key].category && item.category) byId[key].category = item.category;
  }
  byId[key].frameworks[item.frameworkName] = true;
}

// ── Internal: sheet helpers ────────────────────────────────────────────────────

function FMDB_getOrCreateSheet_() {
  var ss    = WD_getClientDbSpreadsheet_();
  var sheet = ss.getSheetByName(FMDB_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(FMDB_SHEET_NAME);
    var initHeaders = FMDB_FIXED_LEAD.map(FMDB_capitalize_)
                        .concat(FMDB_FIXED_TRAIL.map(FMDB_capitalize_));
    sheet.getRange(1, 1, 1, initHeaders.length).setValues([initHeaders]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 240); // id
    sheet.setColumnWidth(2, 320); // name
    sheet.setColumnWidth(3, 130); // type
    sheet.setColumnWidth(4, 150); // category
    sheet.setColumnWidth(5, 170); // updatedAt (first time: no fw cols yet)
  }
  return sheet;
}

/**
 * Reads the current sheet, merges all byId entries, and writes back in one batch.
 * Framework flags are additive — existing flags are never cleared.
 *
 * @returns {{ added, updated, total }}
 */
function FMDB_batchUpsert_(sheet, byId) {
  var data    = sheet.getDataRange().getValues();
  var headers = data.length
    ? data[0].map(function(h) { return String(h).trim(); })
    : FMDB_FIXED_LEAD.map(FMDB_capitalize_).concat(FMDB_FIXED_TRAIL.map(FMDB_capitalize_));

  // Collect all known framework column names: existing + incoming
  var fwSet    = {};
  var fixedAll = FMDB_FIXED_LEAD.concat(FMDB_FIXED_TRAIL).map(function(h) { return h.toLowerCase(); });
  headers.forEach(function(h) {
    if (fixedAll.indexOf(h.toLowerCase()) < 0) fwSet[h] = true;
  });
  Object.keys(byId).forEach(function(k) {
    Object.keys(byId[k].frameworks).forEach(function(fw) { fwSet[fw] = true; });
  });

  // Sort: priority names first, then alphabetical
  var fwCols = Object.keys(fwSet).sort(function(a, b) {
    var ai = FMDB_FW_PRIORITY.indexOf(a);
    var bi = FMDB_FW_PRIORITY.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return  1;
    return a.localeCompare(b);
  });

  // Final header order: fixed lead + framework cols + fixed trail
  var newHeaders = FMDB_FIXED_LEAD.map(FMDB_capitalize_)
    .concat(fwCols)
    .concat(FMDB_FIXED_TRAIL.map(FMDB_capitalize_));

  var oldHdrLow = headers.map(function(h) { return h.toLowerCase(); });
  var newHdrLow = newHeaders.map(function(h) { return h.toLowerCase(); });

  var iId   = newHdrLow.indexOf('id');
  var iName = newHdrLow.indexOf('name');
  var iType = newHdrLow.indexOf('type');
  var iCat  = newHdrLow.indexOf('category');
  var iUpd  = newHdrLow.indexOf('updatedat');

  // Remap existing rows to new header order
  var newRows   = [];
  var idIndex   = {}; // "id|type"        → index in newRows
  var nameIndex = {}; // "lowerName|type" → index in newRows

  for (var r = 1; r < data.length; r++) {
    var oldRow = data[r];
    var newRow = newHeaders.map(function(col) {
      var idx = oldHdrLow.indexOf(col.toLowerCase());
      return idx >= 0 ? oldRow[idx] : FMDB_DASH;
    });
    newRows.push(newRow);

    var rId   = iId   >= 0 ? String(newRow[iId]   || '').trim() : '';
    var rName = iName >= 0 ? String(newRow[iName] || '').trim() : '';
    var rType = iType >= 0 ? String(newRow[iType] || '').trim().toLowerCase() : '';

    if (rId   && rType) idIndex[rId + '|' + rType]                   = newRows.length - 1;
    if (rName && rType) nameIndex[rName.toLowerCase() + '|' + rType] = newRows.length - 1;
  }

  var now     = new Date().toISOString();
  var added   = 0;
  var updated = 0;

  Object.keys(byId).forEach(function(key) {
    var entry     = byId[key];
    var entryId   = (entry.id   || '').trim();
    var entryName = (entry.name || '').trim();
    var typeKey   = entry.type.toLowerCase();

    var idKey   = entryId   ? (entryId   + '|' + typeKey) : null;
    var nameKey = entryName ? (entryName.toLowerCase() + '|' + typeKey) : null;

    // Resolve existing row: ID match first, name match as fallback
    var ri = -1;
    if (idKey   && idIndex.hasOwnProperty(idKey))     ri = idIndex[idKey];
    else if (nameKey && nameIndex.hasOwnProperty(nameKey)) ri = nameIndex[nameKey];

    if (ri >= 0) {
      // ── Merge into existing row ──────────────────────────────────────────
      var row = newRows[ri].slice();

      // Upgrade a name-only row with the resolved ID
      if (iId >= 0 && entryId && !String(row[iId] || '').trim()) {
        row[iId] = entryId;
        if (idKey) idIndex[idKey] = ri;
      }
      if (iName >= 0 && entryName && !String(row[iName] || '').trim()) row[iName] = entryName;
      if (iType >= 0) row[iType] = entry.type;
      if (iCat  >= 0 && entry.category) row[iCat] = entry.category;
      if (iUpd  >= 0) row[iUpd] = now;

      // Add new framework flags; never remove existing ones
      fwCols.forEach(function(fw, fi) {
        var colI   = newHeaders.indexOf(fw);
        var curVal = colI >= 0 ? String(row[colI] || '').trim() : '';
        if (entry.frameworks[fw]) {
          row[colI] = fw;
        } else if (colI >= 0 && (!curVal || curVal === FMDB_DASH)) {
          row[colI] = FMDB_DASH;
        }
      });

      newRows[ri] = row;
      updated++;

    } else {
      // ── Append new row ───────────────────────────────────────────────────
      var newRow = newHeaders.map(function(col) {
        var cL = col.toLowerCase();
        if (cL === 'id')        return entryId;
        if (cL === 'name')      return entryName;
        if (cL === 'type')      return entry.type;
        if (cL === 'category')  return entry.category || '';
        if (cL === 'updatedat') return now;
        return entry.frameworks[col] ? col : FMDB_DASH;
      });
      var newIdx = newRows.length;
      if (idKey)   idIndex[idKey]     = newIdx;
      if (nameKey) nameIndex[nameKey] = newIdx;
      newRows.push(newRow);
      added++;
    }
  });

  var allData = [newHeaders].concat(newRows);
  sheet.clearContents();
  sheet.getRange(1, 1, allData.length, newHeaders.length).setValues(allData);
  sheet.setFrozenRows(1);

  Logger.log('FMDB_batchUpsert_: added=' + added + ' updated=' + updated +
    ' total=' + newRows.length + ' cols=[' + fwCols.join(', ') + ']');

  return { added: added, updated: updated, total: newRows.length };
}

// ── Utility ────────────────────────────────────────────────────────────────────

function FMDB_capitalize_(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ── Editor / diagnostic helpers ────────────────────────────────────────────────

/**
 * Run from Apps Script editor to inspect FrameworkMappingDB stats.
 * Does NOT write anything.
 */
function TEST_FMDB_Inspect() {
  var sheet = FMDB_getOrCreateSheet_();
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) { Logger.log('FrameworkMappingDB: empty.'); return; }

  var headers  = data[0].map(function(h) { return String(h).trim(); });
  var hdrLow   = headers.map(function(h) { return h.toLowerCase(); });
  var fixedAll = FMDB_FIXED_LEAD.concat(FMDB_FIXED_TRAIL).map(function(h) { return h.toLowerCase(); });
  var fwCols   = headers.filter(function(h) { return fixedAll.indexOf(h.toLowerCase()) < 0; });

  var typeCol  = hdrLow.indexOf('type');
  var idCol    = hdrLow.indexOf('id');
  var testCount = 0, docCount = 0, withId = 0;

  for (var i = 1; i < data.length; i++) {
    var type = typeCol >= 0 ? String(data[i][typeCol] || '').trim() : '';
    var id   = idCol   >= 0 ? String(data[i][idCol]   || '').trim() : '';
    if (type === 'Automated Test') testCount++;
    else if (type === 'Document')  docCount++;
    if (id) withId++;
  }

  Logger.log('=== FrameworkMappingDB ===');
  Logger.log('Total rows: ' + (data.length - 1) +
    ' (' + testCount + ' tests, ' + docCount + ' docs)');
  Logger.log('With Vanta ID: ' + withId);
  Logger.log('Frameworks: [' + fwCols.join(', ') + ']');
  Logger.log('Sample rows (first 5):');
  for (var r = 1; r < Math.min(data.length, 6); r++) {
    Logger.log('  ' + JSON.stringify(data[r]));
  }
}
