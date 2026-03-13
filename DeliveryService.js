/** DeliveryService.gs **/

/**
 * UI bootstrap
 */
function WD_getBootstrapData() {
  return {
    appName: APP_CONFIG.APP_NAME,
    tokenServiceUrl: APP_CONFIG.TOKEN_SERVICE_URL,
    modules: [
      { id: 'dashboard', label: 'Dashboard', icon: 'home' },
      { id: 'trustops-v2a', label: 'Trust Ops Tool v2.A', icon: 'shield' },
      { id: 'test-monitoring', label: 'Test Monitoring', icon: 'monitor' },
      { id: 'client-management', label: 'Client Management', icon: 'users' },
      { id: 'framework-explorer', label: 'Framework Explorer', icon: 'layers' },
      { id: 'drive-utility', label: 'Drive Utility', icon: 'drive' },
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

// ── Framework Explorer ────────────────────────────────────────────────────────

/**
 * Returns all frameworks available in the client's Vanta instance.
 */
function WD_getFrameworks(clientName) {
  clientName = String(clientName || '').trim();
  if (!clientName) throw new Error('Client is required.');
  const token = WD_getVantaAccessToken_(clientName);
  const raw = WD_fetchFrameworks_(token);
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