/** DeliveryService.gs **/

/**
 * UI bootstrap
 */
function WD_getBootstrapData() {
  return {
    appName: APP_CONFIG.APP_NAME,
    tokenServiceUrl: getConfigValue('TOKEN_SERVICE_URL') || APP_CONFIG.TOKEN_SERVICE_URL,
    modules: [
      { id: 'dashboard', label: 'Dashboard', icon: 'home' },
      { id: 'trustops-v2a', label: 'Trust Ops Tool v2.A', icon: 'shield' },
      { id: 'test-monitoring', label: 'Test Monitoring', icon: 'monitor' },
      { id: 'client-management', label: 'Client Management', icon: 'users' },
      { id: 'control-mapping', label: 'Framework Mapping', icon: 'layers' },
      { id: 'drive-utility', label: 'Drive Utility', icon: 'drive' },
      { id: 'vendor-risk', label: 'Vendor Risk', icon: 'shield' },
      { id: 'api-test', label: 'Test', icon: 'check' },
      { id: 'coming-soon', label: 'More Tools', icon: 'grid' }
    ]
  };
}

/**
 * Client list for dropdown.
 * Primary path: token service ?action=clients
 * Fallback path: direct read of Central API Sheet if configured locally.
 */
function WD_getClients() {
  const fromService = WD_tryGetClientsFromTokenService_();
  if (fromService && fromService.length) {
    return fromService;
  }

  const fallback = WD_tryGetClientsFromSheet_();
  if (fallback && fallback.length) {
    return fallback;
  }

  throw new Error(
    'Could not load clients. Add ?action=clients to the token service or configure CENTRAL_API_SPREADSHEET_ID locally.'
  );
}

/**
 * Main Trust Ops Tool v2.A action.
 * Pull outstanding tests from Vanta and return structured + formatted output.
 */
function WD_generateTrustOpsV2A(payload) {
  payload = payload || {};

  const clientName = String(payload.clientName || '').trim();
  const clientType = String(payload.clientType || '').trim();
  const projectPlanLink = String(payload.projectPlanLink || '').trim();
  const evidenceDropLink = String(payload.evidenceDropLink || '').trim();
  const cloudSecIncluded = !!payload.cloudSecIncluded;
  const opsLead = String(payload.opsLead || '').trim();

  // Framework selection: IDs for filtering, names for display/storage
  const selectedFrameworkIds = Array.isArray(payload.selectedFrameworkIds) ? payload.selectedFrameworkIds : [];
  const selectedFrameworkNames = Array.isArray(payload.selectedFrameworkNames) ? payload.selectedFrameworkNames : [];
  const frameworks = selectedFrameworkNames.length
    ? selectedFrameworkNames.join(', ')
    : String(payload.frameworks || '').trim();

  if (!clientName) {
    throw new Error('Client is required.');
  }

  // Persist any metadata changes back to DB
  WD_saveClientMetadata(clientName, {
    clientType: clientType,
    projectPlanLink: projectPlanLink,
    evidenceDropLink: evidenceDropLink,
    cloudSecIncluded: cloudSecIncluded,
    opsLead: opsLead,
    frameworks: frameworks
  });

  const token = WD_getVantaAccessToken_(clientName);
  const tests = WD_fetchAllTests_(token);

  const normalized = tests.map(WD_mapTestRecord_);
  const seenTestIds = {};
  let outstanding = normalized
    .filter(function(test) {
      if (test.normalizedStatus !== 'Outstanding') return false;
      if (!test.testId) return true;
      if (seenTestIds[test.testId]) return false;
      seenTestIds[test.testId] = true;
      return true;
    })
    .sort(function(a, b) {
      const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });

  // Fetch outstanding documents (Needs document + Needs update)
  const allDocs = WD_fetchAllDocuments_(token);
  let outstandingDocs = allDocs.map(WD_mapDocumentRecord_);

  // If specific frameworks are selected, fetch control IDs once and use them
  // to filter both tests and documents — avoids re-fetching framework controls twice.
  if (selectedFrameworkIds.length) {
    const controlIds = WD_fetchControlIdsForFrameworks_(token, selectedFrameworkIds);
    const inScopeTestIds = WD_fetchTestIdsForControls_(token, controlIds);
    outstanding = outstanding.filter(function(t) { return !!inScopeTestIds[t.testId]; });
    const inScopeDocIds = WD_fetchDocumentIdsForControls_(token, controlIds);
    outstandingDocs = outstandingDocs.filter(function(d) { return !!inScopeDocIds[d.testId]; });
  }

  // Only fetch failing entities for tests that are true needs-attention style items,
  // following the same approach used in your GAsync logic.
  const idsForEntities = outstanding
    .filter(function(t) { return t.shouldFetchEntities && t.testId; })
    .map(function(t) { return t.testId; });

  const entitiesByTestId = WD_fetchEntitiesBatch_(token, idsForEntities);

  outstanding.forEach(function(test) {
    const allEntities = entitiesByTestId[test.testId] || [];
    test.failingEntityCount = allEntities.length;
    test.failingEntities = allEntities;
    test.showEntityListInline = allEntities.length > 0 && allEntities.length <= 10;
  });

  // Combined items for the structured results table (tests first, then docs)
  const items = outstanding.concat(outstandingDocs);

  const textOutput = WD_buildTrustOpsMessage_({
    clientName: clientName,
    clientType: clientType,
    projectPlanLink: projectPlanLink,
    evidenceDropLink: evidenceDropLink,
    cloudSecIncluded: cloudSecIncluded,
    opsLead: opsLead,
    frameworks: frameworks,
    tests: outstanding,
    documents: outstandingDocs
  });

  const htmlOutput = WD_buildTrustOpsHtml_({
    clientName: clientName,
    clientType: clientType,
    projectPlanLink: projectPlanLink,
    evidenceDropLink: evidenceDropLink,
    cloudSecIncluded: cloudSecIncluded,
    opsLead: opsLead,
    frameworks: frameworks,
    tests: outstanding,
    documents: outstandingDocs
  });

  return {
    clientName: clientName,
    count: items.length,
    tests: outstanding,
    items: items,
    textOutput: textOutput,
    htmlOutput: htmlOutput,
    generatedAt: new Date().toISOString()
  };
}

// ── Control Mapping ───────────────────────────────────────────────────────────

/**
 * Returns all controls for a framework, each with their mapped documents.
 * Server-side CacheService (6hr) keyed on client + frameworkId.
 * Pass forceRefresh:true to bust the cache.
 */
function WD_getFrameworkDocMap(payload) {
  payload = payload || {};
  const clientName   = String(payload.clientName   || '').trim();
  const frameworkId  = String(payload.frameworkId  || '').trim();
  const forceRefresh = !!payload.forceRefresh;

  if (!clientName)  throw new Error('Client is required.');
  if (!frameworkId) throw new Error('Framework ID is required.');

  const cacheKey = 'fdm_' + clientName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + frameworkId;
  const cache    = CacheService.getScriptCache();

  if (!forceRefresh) {
    const hit = cache.get(cacheKey);
    if (hit) {
      try {
        const parsed = JSON.parse(hit);
        parsed.fromCache = true;
        return parsed;
      } catch (_) {}
    }
  }

  const token    = WD_getVantaAccessToken_(clientName);
  const controls = WD_fetchFrameworkDocMapDirect_(token, frameworkId);
  const result   = { controls: controls, fromCache: false, cachedAt: new Date().toISOString() };

  try {
    const s = JSON.stringify(result);
    if (s.length < 100000) cache.put(cacheKey, s, 21600);
  } catch (_) {}

  return result;
}

// ── Framework Explorer ────────────────────────────────────────────────────────

/**
 * Returns all frameworks available in the client's Vanta instance (including out-of-scope when supported by the API).
 */
function WD_getFrameworks(clientName) {
  clientName = String(clientName || '').trim();
  if (!clientName) throw new Error('Client is required.');
  const token = WD_getVantaAccessToken_(clientName);
  const raw = WD_fetchFrameworks_(token, true);
  return raw.map(function(f) {
    return { id: f.id, name: f.name || f.displayName || f.id, description: f.description || '' };
  });
}

/**
 * Returns controls for a specific framework.
 */
function WD_getFrameworkControls(payload) {
  payload = payload || {};
  const clientName = String(payload.clientName || '').trim();
  const frameworkId = String(payload.frameworkId || '').trim();
  if (!clientName) throw new Error('Client is required.');
  if (!frameworkId) throw new Error('Framework ID is required.');
  const token = WD_getVantaAccessToken_(clientName);
  const raw = WD_fetchFrameworkControls_(token, frameworkId);
  return raw.map(function(c) {
    return { id: c.id, name: c.name || c.displayName || c.id, description: c.description || '', category: c.category || '' };
  });
}

/**
 * Returns tests and documents for a specific control.
 */
function WD_getControlDetails(payload) {
  payload = payload || {};
  const clientName = String(payload.clientName || '').trim();
  const controlId = String(payload.controlId || '').trim();
  if (!clientName) throw new Error('Client is required.');
  if (!controlId) throw new Error('Control ID is required.');
  const token = WD_getVantaAccessToken_(clientName);
  const tests = WD_fetchControlTests_(token, controlId);
  const documents = WD_fetchControlDocuments_(token, controlId);
  return {
    tests: tests.map(function(t) {
      return { id: t.id, name: t.name || t.displayName || t.id, status: t.status || '', description: t.description || '' };
    }),
    documents: documents.map(function(d) {
      return { id: d.id, name: d.name || d.displayName || d.id, type: d.type || '', url: d.url || d.link || '' };
    })
  };
}

/**
 * Export helpers: return CSV string + suggested filename for client-side download.
 */
function WD_csvEscape_(val) {
  var s = val === null || val === undefined ? '' : String(val);
  if (s.indexOf('"') >= 0) s = s.replace(/"/g, '""');
  if (/[",\n\r]/.test(s)) return '"' + s + '"';
  return s;
}

function WD_exportTestMonitorCSV() {
  var data = TM_getTestMonitorData();
  var headers = ['Client', 'Frameworks', 'All Tests', 'Scoped Tests', 'Outstanding Tests', 'Deactivated Tests', 'All Docs', 'Scoped Docs', 'Outstanding Docs', 'Deactivated Docs', 'Updated At'];
  var rows = [headers.map(WD_csvEscape_).join(',')];
  data.forEach(function(r) {
    rows.push([
      r.clientName,
      r.frameworks,
      r.allTests,
      r.scopedTests,
      r.outTests,
      r.deactivatedTests,
      r.allDocs,
      r.scopedDocs,
      r.outDocs,
      r.deactivatedDocs,
      r.updatedAt || ''
    ].map(WD_csvEscape_).join(','));
  });
  return { csv: rows.join('\r\n'), filename: 'test-monitor-export.csv' };
}

function WD_exportClientManagementCSV() {
  var data = CM_getAllClientsWithMetadata();
  var headers = ['Client', 'Status', 'Client Type', 'Ops Lead', 'Frameworks', 'Project Plan Link', 'Evidence Drop Link', 'CloudSec'];
  var rows = [headers.map(WD_csvEscape_).join(',')];
  data.forEach(function(r) {
    rows.push([
      r.clientName,
      r.clientStatus || 'Active',
      r.clientType || '',
      r.opsLead || '',
      r.frameworks || '',
      r.projectPlanLink || '',
      r.evidenceDropLink || '',
      r.cloudSecIncluded ? 'Yes' : 'No'
    ].map(WD_csvEscape_).join(','));
  });
  return { csv: rows.join('\r\n'), filename: 'client-management-export.csv' };
}

function WD_exportFrameworkMappingCSV() {
  var out = WD_getFrameworkMappingDBForUI();
  var headers = ['name', 'type', 'category', 'updatedAt'].concat(out.frameworkColumns || []);
  var rows = [headers.map(WD_csvEscape_).join(',')];
  (out.rows || []).forEach(function(r) {
    var row = [r.name, r.type, r.category, r.updatedAt || ''];
    (out.frameworkColumns || []).forEach(function(fw) {
      row.push(r.frameworks && r.frameworks[fw] ? 'Yes' : '');
    });
    rows.push(row.map(WD_csvEscape_).join(','));
  });
  return { csv: rows.join('\r\n'), filename: 'framework-mapping-export.csv' };
}

// ── Test: verify tests & documents are pulled ───────────────────────────────────

/**
 * Fetches controls, tests, and documents for a client (and optional framework) to verify the API is returning data.
 * Use from the UI Test module or from the script editor. Does not write to Framework Mapping DB.
 *
 * @param {Object} [payload]
 *   clientName    {string}  Default "Beacon Street Studios".
 *   frameworkId   {string}  Optional. If omitted, first framework for the client is used.
 *   frameworkName {string}  Optional. For display when frameworkId is provided.
 * @returns {Object} { clientName, frameworkName, frameworkId, controlCount, totalTests, totalDocuments, sample: Array<{controlName, testCount, docCount}>, error?: string }
 */
function WD_testFetchTestsAndDocuments(payload) {
  payload = payload || {};
  var clientName = String(payload.clientName || 'Beacon Street Studios').trim();
  var frameworkId = String(payload.frameworkId || '').trim();
  var frameworkName = String(payload.frameworkName || '').trim();

  try {
    if (!frameworkId) {
      var frameworks = WD_getFrameworks(clientName);
      if (!frameworks || !frameworks.length) {
        return { clientName: clientName, error: 'No frameworks found for client.' };
      }
      frameworkId = frameworks[0].id;
      frameworkName = frameworks[0].name || frameworks[0].id;
    }

    var result = WD_getFrameworkDocMap({
      clientName: clientName,
      frameworkId: frameworkId,
      forceRefresh: true
    });

    var controls = result.controls || [];
    var totalTests = 0;
    var totalDocs = 0;
    var sample = [];
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      var tests = c.tests || [];
      var docs = c.documents || [];
      totalTests += tests.length;
      totalDocs += docs.length;
      if (sample.length < 5) {
        sample.push({
          controlName: c.name || c.id || ('Control ' + (i + 1)),
          testCount: tests.length,
          docCount: docs.length
        });
      }
    }

    return {
      clientName: clientName,
      frameworkName: frameworkName,
      frameworkId: frameworkId,
      controlCount: controls.length,
      totalTests: totalTests,
      totalDocuments: totalDocs,
      sample: sample,
      fromCache: !!result.fromCache
    };
  } catch (e) {
    return {
      clientName: clientName,
      error: (e && e.message) ? e.message : String(e)
    };
  }
}

/**
 * Run from the Apps Script editor to verify tests and documents are pulled for Beacon Street Studios.
 * View > Logs to see the result.
 */
function TEST_fetchTestsAndDocs_BeaconStreet() {
  var result = WD_testFetchTestsAndDocuments({ clientName: 'Beacon Street Studios' });
  Logger.log(JSON.stringify(result, null, 2));
  if (result.error) {
    Logger.log('FAILED: ' + result.error);
  } else {
    Logger.log('OK — Controls: ' + result.controlCount + ', Tests: ' + result.totalTests + ', Documents: ' + result.totalDocuments);
  }
  return result;
}
