/** TokenAndVanta.gs **/

function WD_tryGetClientsFromTokenService_() {
  const url = (getConfigValue('TOKEN_SERVICE_URL') || '').replace(/\/$/, '') + '?action=clients';

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const text = resp.getContentText() || '';

    if (code < 200 || code >= 300) {
      return [];
    }

    const json = JSON.parse(text || '{}');
    const clients = Array.isArray(json.clients) ? json.clients : [];

    return clients
      .map(function(x) { return String(x || '').trim(); })
      .filter(Boolean)
      .sort();
  } catch (err) {
    return [];
  }
}

function WD_tryGetClientsFromSheet_() {
  if (!getConfigValue('CENTRAL_API_SPREADSHEET_ID')) return [];

  const ss = SpreadsheetApp.openById(getConfigValue('CENTRAL_API_SPREADSHEET_ID'));
  const sheetName = getConfigValue('CENTRAL_API_SHEET_NAME');
  const sh = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];

  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];

  const header = values[0].map(String);
  const clientCol = header.indexOf('Client');
  if (clientCol < 0) {
    throw new Error('Central API Sheet must contain a "Client" header.');
  }

  const out = [];
  for (var i = 1; i < values.length; i++) {
    const name = String(values[i][clientCol] || '').trim();
    if (name) out.push(name);
  }

  return Array.from(new Set(out)).sort();
}

// Token cache TTL: 5 minutes. Reduces repeated token-service calls per client per execution.
var TOKEN_CACHE_TTL_SECONDS = 300;

function WD_getVantaAccessToken_(clientName) {
  var normalized = String(clientName || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  var cacheKey   = 'token_' + (normalized || 'default');
  var cache      = CacheService.getScriptCache();
  var cached     = cache.get(cacheKey);
  if (cached) return cached;

  var url = (getConfigValue('TOKEN_SERVICE_URL') || '').replace(/\/$/, '') +
    '?action=token&client=' + encodeURIComponent(clientName);

  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText() || '';

  if (code < 200 || code >= 300) {
    throw new Error('Token service HTTP ' + code + ': ' + text.substring(0, 300));
  }

  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Token service returned invalid JSON.');
  }

  if (!json.access_token) {
    throw new Error('Token service did not return access_token.');
  }

  var token = json.access_token;
  cache.put(cacheKey, token, TOKEN_CACHE_TTL_SECONDS);
  return token;
}

function WD_fetchAllTests_(token) {
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token
  };

  const all = WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);

  // Deduplicate by id — Vanta can return the same test on multiple pages
  const byId = {};
  all.forEach(function(t) {
    const id = t && (t.id || t.testId);
    if (id && !byId[id]) byId[id] = t;
  });
  return Object.keys(byId).map(function(id) { return byId[id]; });
}

function WD_fetchEntitiesBatch_(token, testIds) {
  const out = {};
  if (!testIds || !testIds.length) return out;

  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token
  };

  const uniqueIds = Array.from(new Set(testIds.filter(Boolean)));
  const pending = uniqueIds.map(function(id) {
    return { testId: id, cursor: null };
  });

  uniqueIds.forEach(function(id) {
    out[id] = [];
  });

  let queue = pending;

  while (queue.length > 0) {
    const requests = queue.map(function(item) {
      let url = APP_CONFIG.VANTA_API_BASE +
        '/tests/' + encodeURIComponent(item.testId) +
        '/entities?entityStatus=FAILING&pageSize=' + APP_CONFIG.API_PAGE_SIZE;
      if (item.cursor) {
        url += '&pageCursor=' + WD_encodeCursorSafely_(item.cursor);
      }

      return {
        url: url,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });

    const responses = UrlFetchApp.fetchAll(requests);
    const nextQueue = [];

    for (var i = 0; i < responses.length; i++) {
      const item = queue[i];
      const resp = responses[i];
      const code = resp.getResponseCode();
      const text = resp.getContentText() || '{}';

      if (code === 429 || (code >= 500 && code < 600)) {
        nextQueue.push(item);
        continue;
      }

      if (code < 200 || code >= 300) {
        throw new Error(
          'Entities fetch failed for test ' + item.testId + ' (' + code + '): ' + text.substring(0, 300)
        );
      }

      const json = JSON.parse(text || '{}');
      const results = json.results || {};
      const data = results.data || [];

      data.forEach(function(entity) {
        const name =
          String(entity.displayName || entity.name || entity.hostname || entity.id || '').trim();
        if (name) out[item.testId].push(name);
      });

      const pageInfo = results.pageInfo || {};
      if (pageInfo.hasNextPage && pageInfo.endCursor) {
        nextQueue.push({
          testId: item.testId,
          cursor: pageInfo.endCursor
        });
      }
    }

    queue = nextQueue;
    if (queue.length) {
      Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
    }
  }

  Object.keys(out).forEach(function(testId) {
    out[testId] = Array.from(new Set(out[testId])).sort();
  });

  return out;
}

function WD_pagedGetAll_(getUrlFn, headers) {
  const all = [];
  let cursor = null;

  do {
    const url = getUrlFn(cursor);
    const body = WD_fetchJsonWithRetry_({
      url: url,
      method: 'get',
      options: { headers: headers }
    });

    const results = body.results || {};
    const data = results.data || [];
    Array.prototype.push.apply(all, data);

    const pageInfo = results.pageInfo || {};
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;

    Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
  } while (cursor);

  return all;
}

function WD_fetchJsonWithRetry_(req) {
  const method = req.method || 'get';
  const url = req.url;
  const options = req.options || {};

  let attempt = 0;

  while (true) {
    const resp = UrlFetchApp.fetch(url, Object.assign({
      method: method,
      muteHttpExceptions: true
    }, options));

    const code = resp.getResponseCode();
    const text = resp.getContentText() || '{}';

    if (code >= 200 && code < 300) {
      return JSON.parse(text);
    }

    const bandwidthQuota = (code === 403 || code === 429) && /bandwidth\s*quota\s*exceeded/i.test(text);
    const retriable = bandwidthQuota || (code === 429 || (code >= 500 && code < 600));
    if (retriable && attempt < APP_CONFIG.MAX_RETRIES) {
      const headers = resp.getAllHeaders && resp.getAllHeaders();
      const retryAfter = headers && (headers['Retry-After'] || headers['retry-after']);

      let delay = retryAfter
        ? Number(retryAfter) * 1000
        : APP_CONFIG.BACKOFF_BASE_MS * Math.pow(2, attempt);
      if (bandwidthQuota && delay < 5000) delay = 5000;
      delay += Math.floor(Math.random() * 250);
      Utilities.sleep(Math.max(delay, APP_CONFIG.RATE_LIMIT_MIN_MS));
      attempt++;
      continue;
    }

    throw new Error(method.toUpperCase() + ' ' + url + ' failed (' + code + '): ' + text.substring(0, 500));
  }
}

function WD_encodeCursorSafely_(cursor) {
  if (!cursor) return '';
  const s = String(cursor);
  if (/%[0-9A-Fa-f]{2}/.test(s)) return s;
  return encodeURIComponent(s);
}

// ── Framework Explorer API functions ──────────────────────────────────────────

/**
 * Fetches frameworks from Vanta.
 * @param {string} token
 * @param {boolean} [includeOutOfScope] - If true, request may include frameworks not in scope (Vanta API may support includeOutOfScope or similar; ignored if unsupported).
 */
function WD_fetchFrameworks_(token, includeOutOfScope) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  return WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/frameworks?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (includeOutOfScope) url += '&includeOutOfScope=true';
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);
}

function WD_fetchFrameworkControls_(token, frameworkId) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  return WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/frameworks/' + encodeURIComponent(frameworkId) + '/controls?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);
}

function WD_fetchControlTests_(token, controlId) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  return WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(controlId) + '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);
}

function WD_fetchControlDocuments_(token, controlId) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  return WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(controlId) + '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);
}

/**
 * Fetches all controls for a framework with their tests and documents (batched).
 * Used by Framework Mapping UI (WD_getFrameworkDocMap).
 * @param {string} token
 * @param {string} frameworkId
 * @returns {Array<{ id: string, name: string, category: string, tests: Array<{id,name,status}>, documents: Array<{id,name,type,url}> }>}
 */
function WD_fetchFrameworkDocMapDirect_(token, frameworkId) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  const controls = WD_fetchFrameworkControls_(token, frameworkId);
  const BATCH = 20;
  const out = [];

  for (var i = 0; i < controls.length; i += BATCH) {
    var batch = controls.slice(i, i + BATCH);
    var testReqs = batch.map(function(ctrl) {
      return {
        url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(ctrl.id) + '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });
    var docReqs = batch.map(function(ctrl) {
      return {
        url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(ctrl.id) + '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });

    var testResponses = UrlFetchApp.fetchAll(testReqs);
    if (i + BATCH < controls.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
    var docResponses = UrlFetchApp.fetchAll(docReqs);
    if (i + BATCH < controls.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);

    for (var j = 0; j < batch.length; j++) {
      var ctrl = batch[j];
      var tests = [];
      var docs = [];
      if (testResponses[j] && testResponses[j].getResponseCode() >= 200 && testResponses[j].getResponseCode() < 300) {
        var tBody = JSON.parse(testResponses[j].getContentText() || '{}');
        var tData = (tBody.results && tBody.results.data) ? tBody.results.data : (tBody.data || []);
        if (Array.isArray(tData)) {
          tData.forEach(function(t) {
            tests.push({
              id: t.id || t.testId || '',
              name: t.name || t.displayName || t.id || t.testId || '',
              status: t.status || ''
            });
          });
        }
      }
      if (docResponses[j] && docResponses[j].getResponseCode() >= 200 && docResponses[j].getResponseCode() < 300) {
        var dBody = JSON.parse(docResponses[j].getContentText() || '{}');
        var dData = (dBody.results && dBody.results.data) ? dBody.results.data : (dBody.data || []);
        if (Array.isArray(dData)) {
          dData.forEach(function(d) {
            docs.push({
              id: d.id || d.documentId || '',
              name: d.name || d.title || d.displayName || d.id || d.documentId || '',
              type: d.type || d.category || '',
              url: d.url || d.link || ''
            });
          });
        }
      }
      out.push({
        id: ctrl.id,
        name: ctrl.name || ctrl.displayName || ctrl.id,
        category: ctrl.category || '',
        tests: tests,
        documents: docs
      });
    }
  }
  return out;
}

/**
 * Returns all control IDs for the given framework IDs.
 * Used to avoid re-fetching controls when filtering both tests and documents.
 */
function WD_fetchControlIdsForFrameworks_(token, frameworkIds) {
  const controlIds = [];
  frameworkIds.forEach(function(frameworkId) {
    const controls = WD_fetchFrameworkControls_(token, frameworkId);
    controls.forEach(function(c) { if (c.id) controlIds.push(c.id); });
  });
  return controlIds;
}

/**
 * Batch-fetches test IDs for a pre-fetched list of control IDs.
 * Returns { testId: true } for O(1) lookup.
 */
function WD_fetchTestIdsForControls_(token, controlIds) {
  if (!controlIds || !controlIds.length) return {};
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  const testIdSet = {};
  const BATCH = 20;

  for (var i = 0; i < controlIds.length; i += BATCH) {
    const batch = controlIds.slice(i, i + BATCH);
    const requests = batch.map(function(controlId) {
      return {
        url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(controlId) +
             '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });
    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(resp) {
      const code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        const body = JSON.parse(resp.getContentText() || '{}');
        const data = (body.results || {}).data || [];
        data.forEach(function(t) {
          const id = t && (t.id || t.testId);
          if (id) testIdSet[id] = true;
        });
      }
    });
    if (i + BATCH < controlIds.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
  }
  return testIdSet;
}

/**
 * Batch-fetches document IDs for a pre-fetched list of control IDs.
 * Returns { docId: true } for O(1) lookup.
 */
function WD_fetchDocumentIdsForControls_(token, controlIds) {
  if (!controlIds || !controlIds.length) return {};
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  const docIdSet = {};
  const BATCH = 20;

  for (var i = 0; i < controlIds.length; i += BATCH) {
    const batch = controlIds.slice(i, i + BATCH);
    const requests = batch.map(function(controlId) {
      return {
        url: APP_CONFIG.VANTA_API_BASE + '/controls/' + encodeURIComponent(controlId) +
             '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE,
        method: 'get',
        headers: headers,
        muteHttpExceptions: true
      };
    });
    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(resp) {
      const code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        const body = JSON.parse(resp.getContentText() || '{}');
        const data = (body.results || {}).data || [];
        data.forEach(function(d) {
          const id = d && (d.id || d.documentId);
          if (id) docIdSet[id] = true;
        });
      }
    });
    if (i + BATCH < controlIds.length) Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
  }
  return docIdSet;
}

/**
 * Convenience wrapper: framework IDs → test ID set.
 */
function WD_fetchTestIdsForFrameworks_(token, frameworkIds) {
  if (!frameworkIds || !frameworkIds.length) return {};
  return WD_fetchTestIdsForControls_(token, WD_fetchControlIdsForFrameworks_(token, frameworkIds));
}

/**
 * Fetch all outstanding documents (Needs document + Needs update statuses).
 * Queries each status bucket separately and dedupes by ID.
 */
function WD_fetchAllDocuments_(token) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  const STATUSES = ['Needs document', 'Needs update'];
  const byId = {};

  STATUSES.forEach(function(st) {
    const docs = WD_pagedGetAll_(function(cursor) {
      let url = APP_CONFIG.VANTA_API_BASE + '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE +
        '&statusMatchesAny=' + encodeURIComponent(st);
      if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
      return url;
    }, headers);

    docs.forEach(function(d) {
      if (!d) return;
      const id = d.id || d.documentId;
      if (!id) return;
      if (!d.id) d.id = id;
      if (!d.status) d.status = st;
      if (!byId[id]) byId[id] = d;
    });
  });

  return Object.keys(byId).map(function(id) { return byId[id]; });
}

/**
 * Fetch all documents regardless of status (for Test Monitor full client sheets).
 * Queries each status bucket and dedupes by ID.
 * Statuses per Vanta API: Needs document, Needs update, Not relevant, OK.
 */
function WD_fetchAllDocsAllStatuses_(token) {
  var headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  var STATUSES = ['Needs document', 'Needs update', 'Not relevant', 'OK'];
  var byId = {};

  STATUSES.forEach(function(st) {
    try {
      var docs = WD_pagedGetAll_(function(cursor) {
        var url = APP_CONFIG.VANTA_API_BASE + '/documents?pageSize=' + APP_CONFIG.API_PAGE_SIZE +
          '&statusMatchesAny=' + encodeURIComponent(st);
        if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
        return url;
      }, headers);

      docs.forEach(function(d) {
        if (!d) return;
        var id = d.id || d.documentId;
        if (!id) return;
        if (!d.id) d.id = id;
        if (!d.status) d.status = st;
        if (!byId[id]) byId[id] = d;
      });
    } catch (e) {
      Logger.log('WD_fetchAllDocsAllStatuses_: skipped status "' + st + '": ' + (e && e.message ? e.message : String(e)));
    }
  });

  return Object.keys(byId).map(function(id) { return byId[id]; });
}

/**
 * Convenience wrapper: framework IDs → document ID set.
 */
function WD_fetchDocumentIdsForFrameworks_(token, frameworkIds) {
  if (!frameworkIds || !frameworkIds.length) return {};
  return WD_fetchDocumentIdsForControls_(token, WD_fetchControlIdsForFrameworks_(token, frameworkIds));
}

// ── Token service proxy (for future use once token service is redeployed) ──────

/**
 * Calls an action on the token service and returns the parsed JSON response.
 */
function WD_callTokenService_(action, extraParams) {
  let url = (getConfigValue('TOKEN_SERVICE_URL') || '').replace(/\/$/, '') + '?action=' + encodeURIComponent(action);
  if (extraParams) {
    Object.keys(extraParams).forEach(function(k) {
      url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]);
    });
  }

  const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const text = resp.getContentText() || '{}';

  if (code < 200 || code >= 300) {
    throw new Error('Token service HTTP ' + code + ': ' + text.substring(0, 300));
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Token service returned invalid JSON.');
  }

  if (json.error) {
    throw new Error('Token service error: ' + json.error);
  }

  return json;
}