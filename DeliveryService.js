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

  if (!clientName) {
    throw new Error('Client is required.');
  }

  const token = WD_getVantaAccessToken_(clientName);
  const tests = WD_fetchAllTests_(token);

  const normalized = tests.map(WD_mapTestRecord_);
  const outstanding = normalized
    .filter(function(test) {
      return test.normalizedStatus === 'Outstanding';
    })
    .sort(function(a, b) {
      const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });

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

  const textOutput = WD_buildTrustOpsMessage_({
    clientName: clientName,
    clientType: clientType,
    projectPlanLink: projectPlanLink,
    evidenceDropLink: evidenceDropLink,
    cloudSecIncluded: cloudSecIncluded,
    tests: outstanding
  });

  const htmlOutput = WD_buildTrustOpsHtml_({
    clientName: clientName,
    clientType: clientType,
    projectPlanLink: projectPlanLink,
    evidenceDropLink: evidenceDropLink,
    cloudSecIncluded: cloudSecIncluded,
    tests: outstanding
  });

  return {
    clientName: clientName,
    count: outstanding.length,
    tests: outstanding,
    textOutput: textOutput,
    htmlOutput: htmlOutput,
    generatedAt: new Date().toISOString()
  };
}