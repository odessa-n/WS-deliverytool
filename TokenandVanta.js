/** TokenAndVanta.gs **/

function WD_tryGetClientsFromTokenService_() {
  const url = APP_CONFIG.TOKEN_SERVICE_URL.replace(/\/$/, '') + '?action=clients';

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
  if (!APP_CONFIG.CENTRAL_API_SPREADSHEET_ID) return [];

  const ss = SpreadsheetApp.openById(APP_CONFIG.CENTRAL_API_SPREADSHEET_ID);
  const sh = APP_CONFIG.CENTRAL_API_SHEET_NAME
    ? ss.getSheetByName(APP_CONFIG.CENTRAL_API_SHEET_NAME)
    : ss.getSheets()[0];

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

function WD_getVantaAccessToken_(clientName) {
  const url = APP_CONFIG.TOKEN_SERVICE_URL.replace(/\/$/, '') +
    '?action=token&client=' + encodeURIComponent(clientName);

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText() || '';

  if (code < 200 || code >= 300) {
    throw new Error('Token service HTTP ' + code + ': ' + text.substring(0, 300));
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('Token service returned invalid JSON.');
  }

  if (!json.access_token) {
    throw new Error('Token service did not return access_token.');
  }

  return json.access_token;
}

function WD_fetchAllTests_(token) {
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token
  };

  return WD_pagedGetAll_(function(cursor) {
    let url = APP_CONFIG.VANTA_API_BASE + '/tests?pageSize=' + APP_CONFIG.API_PAGE_SIZE;
    if (cursor) url += '&pageCursor=' + WD_encodeCursorSafely_(cursor);
    return url;
  }, headers);
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

    const retriable = (code === 429 || (code >= 500 && code < 600));
    if (retriable && attempt < APP_CONFIG.MAX_RETRIES) {
      const headers = resp.getAllHeaders && resp.getAllHeaders();
      const retryAfter = headers && (headers['Retry-After'] || headers['retry-after']);

      let delay = retryAfter
        ? Number(retryAfter) * 1000
        : APP_CONFIG.BACKOFF_BASE_MS * Math.pow(2, attempt);

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