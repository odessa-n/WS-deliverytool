/** VendorRisk.gs **/

// ── Vendor Risk: Public entry points ─────────────────────────────────────────

/**
 * Fetches all vendors + their latest security review for a client.
 * Returns structured data for the Vendor Risk dashboard.
 *
 * @param {Object} payload
 *   clientName       {string}  Required. Vanta client name.
 *   riskFilter       {string}  Optional. 'all' | 'critical' | 'high' | 'critical_high'
 * @returns {Object}  { vendors: [...], fetchedAt: ISO string, clientName }
 */
function WD_getVendorDashboard(payload) {
  payload = payload || {};
  var clientName = String(payload.clientName || '').trim();
  if (!clientName) throw new Error('clientName is required.');

  var riskFilter = String(payload.riskFilter || 'all').toLowerCase();

  var vendors   = VR_listVendors_(clientName);
  var riskAttrs = VR_listVendorRiskAttributes_(clientName);

  // Filter by risk if requested
  if (riskFilter === 'critical') {
    vendors = vendors.filter(function(v) { return VR_riskLevel_(v) === 'Critical'; });
  } else if (riskFilter === 'high') {
    vendors = vendors.filter(function(v) { return VR_riskLevel_(v) === 'High'; });
  } else if (riskFilter === 'critical_high') {
    vendors = vendors.filter(function(v) {
      var lvl = VR_riskLevel_(v);
      return lvl === 'Critical' || lvl === 'High';
    });
  }

  // Fetch security reviews for every vendor (sequential to respect rate limits)
  var results = vendors.map(function(vendor) {
    var vendorId = vendor.id || '';
    var reviews  = [];
    try {
      reviews = VR_getVendorReviews_(clientName, vendorId);
    } catch (e) {
      Logger.log('WARN: Could not fetch reviews for vendor ' + vendorId + ': ' + e.message);
    }

    var latestReview = VR_getLatestReview_(reviews);
    var reviewStatus = VR_reviewStatus_(latestReview);

    return {
      id:              vendorId,
      name:            String(vendor.name || '').trim(),
      websiteUrl:      String(vendor.websiteUrl || '').trim(),
      categoryDisplay: String(vendor.categoryDisplay || '').trim(),
      status:          String(vendor.status || '').trim(),
      riskLevel:       VR_riskLevel_(vendor),
      assessmentStatus:String(vendor.assessmentStatus || '').trim(),
      authMethod:      String(vendor.authMethod || '').trim(),
      reviews:         reviews.map(VR_normalizeReview_),
      latestReviewDate:latestReview ? String(latestReview.reviewDate || '') : null,
      latestReviewStatus: latestReview ? String(latestReview.status || '') : null,
      reviewStatus:    reviewStatus
    };
  });

  return {
    clientName:  clientName,
    vendors:     results,
    riskAttrs:   riskAttrs,
    fetchedAt:   new Date().toISOString(),
    total:       results.length,
    needsReview: results.filter(function(v) {
      return v.reviewStatus === 'Never Reviewed' || v.reviewStatus === 'Overdue';
    }).length
  };
}


/**
 * Upload a document from Google Drive to a Vanta vendor.
 *
 * @param {Object} payload
 *   clientName     {string}  Required.
 *   vendorId       {string}  Required. Vanta vendor ID.
 *   driveFileId    {string}  Required. Google Drive file ID.
 *   documentTitle  {string}  Required. Title to display in Vanta.
 *   documentType   {string}  Optional. e.g. 'soc2_report', 'iso27001_certificate'.
 */
function WD_uploadDocumentToVendor(payload) {
  payload = payload || {};
  var clientName    = String(payload.clientName    || '').trim();
  var vendorId      = String(payload.vendorId      || '').trim();
  var driveFileId   = String(payload.driveFileId   || '').trim();
  var documentTitle = String(payload.documentTitle || '').trim();
  var documentType  = String(payload.documentType  || 'other').trim();

  if (!clientName)    throw new Error('clientName is required.');
  if (!vendorId)      throw new Error('vendorId is required.');
  if (!driveFileId)   throw new Error('driveFileId is required.');
  if (!documentTitle) throw new Error('documentTitle is required.');

  var token = WD_getVantaAccessToken_(clientName);
  var file  = DriveApp.getFileById(driveFileId);
  var blob  = file.getBlob();

  var url = APP_CONFIG.VANTA_API_BASE + '/vendors/' + encodeURIComponent(vendorId) + '/documents';
  var response = VR_postMultipart_(token, url, blob, documentTitle, documentType);
  WD_appendAuditLog_('Upload vendor document', 'client=' + clientName + ' vendorId=' + vendorId);

  return { success: true, vendorId: vendorId, response: response };
}


/**
 * Upload a document from Google Drive to a specific vendor security review.
 *
 * @param {Object} payload
 *   clientName      {string}  Required.
 *   vendorId        {string}  Required.
 *   securityReviewId {string} Required.
 *   driveFileId     {string}  Required. Google Drive file ID.
 *   documentTitle   {string}  Required.
 *   documentType    {string}  Optional.
 */
function WD_uploadDocumentToReview(payload) {
  payload = payload || {};
  var clientName       = String(payload.clientName       || '').trim();
  var vendorId         = String(payload.vendorId         || '').trim();
  var securityReviewId = String(payload.securityReviewId || '').trim();
  var driveFileId      = String(payload.driveFileId      || '').trim();
  var documentTitle   = String(payload.documentTitle    || '').trim();
  var documentType     = String(payload.documentType     || 'other').trim();

  if (!clientName)       throw new Error('clientName is required.');
  if (!vendorId)         throw new Error('vendorId is required.');
  if (!securityReviewId) throw new Error('securityReviewId is required.');
  if (!driveFileId)      throw new Error('driveFileId is required.');
  if (!documentTitle)    throw new Error('documentTitle is required.');

  var token = WD_getVantaAccessToken_(clientName);
  var file  = DriveApp.getFileById(driveFileId);
  var blob  = file.getBlob();

  var url = APP_CONFIG.VANTA_API_BASE +
    '/vendors/' + encodeURIComponent(vendorId) +
    '/security-reviews/' + encodeURIComponent(securityReviewId) +
    '/documents';

  var response = VR_postMultipart_(token, url, blob, documentTitle, documentType);
  WD_appendAuditLog_('Upload document to review', 'client=' + clientName + ' vendorId=' + vendorId + ' reviewId=' + securityReviewId);

  return { success: true, vendorId: vendorId, securityReviewId: securityReviewId, response: response };
}


/**
 * Auto-upload matching documents from the vendor doc library for Critical/High vendors
 * that are missing a current review.
 *
 * @param {Object} payload
 *   clientName    {string}  Required.
 *   onlyOverdue   {boolean} Default true. Skip vendors with a current review.
 * @returns {Object} { uploaded: [...], skipped: [...], errors: [...] }
 */
function WD_autoUploadVendorDocs(payload) {
  payload = payload || {};
  var clientName  = String(payload.clientName || '').trim();
  var onlyOverdue = payload.onlyOverdue !== false; // default true

  if (!clientName) throw new Error('clientName is required.');

  var vendors = VR_listVendors_(clientName);

  // Only process Critical and High risk vendors
  vendors = vendors.filter(function(v) {
    var lvl = VR_riskLevel_(v);
    return lvl === 'Critical' || lvl === 'High';
  });

  var token    = WD_getVantaAccessToken_(clientName);
  var library  = VR_getDocLibrary_();
  var uploaded = [];
  var skipped  = [];
  var errors   = [];

  vendors.forEach(function(vendor) {
    var vendorId   = vendor.id || vendor.uid || '';
    var vendorName = String(vendor.name || vendor.displayName || '').trim();

    try {
      var reviews = VR_getVendorReviews_(clientName, vendorId);
      var latest  = VR_getLatestReview_(reviews);
      var status  = VR_reviewStatus_(latest);

      if (onlyOverdue && status === 'Current') {
        skipped.push({ vendorId: vendorId, vendorName: vendorName, reason: 'Review is current' });
        return;
      }

      var matchingDocs = VR_findDocsForVendor_(library, vendorName);
      if (!matchingDocs.length) {
        skipped.push({ vendorId: vendorId, vendorName: vendorName, reason: 'No docs in library' });
        return;
      }

      matchingDocs.forEach(function(doc) {
        try {
          var file = DriveApp.getFileById(doc.driveFileId);
          var blob = file.getBlob();
          var url  = APP_CONFIG.VANTA_API_BASE + '/vendors/' + encodeURIComponent(vendorId) + '/documents';
          VR_postMultipart_(token, url, blob, doc.documentTitle, doc.documentType);
          uploaded.push({
            vendorId:      vendorId,
            vendorName:    vendorName,
            documentTitle: doc.documentTitle,
            documentType:  doc.documentType
          });
          Utilities.sleep(APP_CONFIG.RATE_LIMIT_MIN_MS);
        } catch (e) {
          errors.push({
            vendorId:   vendorId,
            vendorName: vendorName,
            doc:        doc.documentTitle,
            error:      e.message
          });
        }
      });

    } catch (e) {
      errors.push({ vendorId: vendorId, vendorName: vendorName, error: e.message });
    }
  });

  return {
    clientName: clientName,
    uploaded:   uploaded,
    skipped:    skipped,
    errors:     errors
  };
}


/**
 * Returns the vendor document library from the configured Google Sheet.
 * Each row: Vendor Name | Document Title | Document Type | Drive File ID | Valid Until
 *
 * @returns {Array} Array of doc objects.
 */
function WD_getVendorDocLibrary() {
  return VR_getDocLibrary_();
}


// ── Vanta API helpers — delegate reads to token service ───────────────────────
// The fetch logic (pagination, normalization, rate limiting) lives in
// WS-VantaAPITokenService/vanta_api.js, the same as tests and documents.
// These helpers call the service endpoint and return the normalised data.

function VR_listVendors_(clientName) {
  var url = (getConfigValue('TOKEN_SERVICE_URL') || APP_CONFIG.TOKEN_SERVICE_URL).replace(/\/$/, '') +
    '?action=vendors&client=' + encodeURIComponent(clientName);
  var resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var code = resp.getResponseCode();
  var text = resp.getContentText() || '{}';
  if (code < 200 || code >= 300) {
    throw new Error('vendors fetch HTTP ' + code + ': ' + text.substring(0, 300));
  }
  var json = JSON.parse(text);
  return Array.isArray(json.vendors) ? json.vendors : [];
}

function VR_getVendorReviews_(clientName, vendorId) {
  var url = (getConfigValue('TOKEN_SERVICE_URL') || APP_CONFIG.TOKEN_SERVICE_URL).replace(/\/$/, '') +
    '?action=vendor-reviews&client=' + encodeURIComponent(clientName) +
    '&vendorId=' + encodeURIComponent(vendorId);
  var resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var code = resp.getResponseCode();
  var text = resp.getContentText() || '{}';
  if (code < 200 || code >= 300) {
    throw new Error('vendor-reviews fetch HTTP ' + code + ': ' + text.substring(0, 300));
  }
  var json = JSON.parse(text);
  return Array.isArray(json.reviews) ? json.reviews : [];
}

function VR_listVendorRiskAttributes_(clientName) {
  var url = (getConfigValue('TOKEN_SERVICE_URL') || APP_CONFIG.TOKEN_SERVICE_URL).replace(/\/$/, '') +
    '?action=vendor-risk-attributes&client=' + encodeURIComponent(clientName);
  var resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var code = resp.getResponseCode();
  var text = resp.getContentText() || '{}';
  if (code < 200 || code >= 300) {
    throw new Error('vendor-risk-attributes fetch HTTP ' + code + ': ' + text.substring(0, 300));
  }
  var json = JSON.parse(text);
  return Array.isArray(json.riskAttributes) ? json.riskAttributes : [];
}


// ── Upload helper ─────────────────────────────────────────────────────────────

function VR_postMultipart_(token, url, blob, documentTitle, documentType) {
  var boundary = 'WD_boundary_' + Utilities.getUuid().replace(/-/g, '');

  var bodyParts = [
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="documentTitle"\r\n\r\n' +
    documentTitle + '\r\n',
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="documentType"\r\n\r\n' +
    documentType + '\r\n'
  ];

  var textPart = bodyParts.join('');
  var textBytes = Utilities.newBlob(textPart).getBytes();

  var fileHeader = '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + blob.getName() + '"\r\n' +
    'Content-Type: ' + blob.getContentType() + '\r\n\r\n';
  var fileHeaderBytes = Utilities.newBlob(fileHeader).getBytes();

  var fileBytes  = blob.getBytes();
  var closingBytes = Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes();

  var combined = textBytes.concat(fileHeaderBytes).concat(fileBytes).concat(closingBytes);
  var payload  = Utilities.newBlob(combined, 'application/octet-stream');

  var resp = UrlFetchApp.fetch(url, {
    method:             'post',
    muteHttpExceptions: true,
    headers: {
      Authorization:  'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary
    },
    payload: payload.getBytes()
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText() || '{}';

  if (code < 200 || code >= 300) {
    throw new Error('Upload failed (' + code + '): ' + text.substring(0, 400));
  }

  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}


// ── Review status helpers ─────────────────────────────────────────────────────

function VR_getLatestReview_(reviews) {
  if (!reviews || !reviews.length) return null;
  var sorted = reviews.slice().sort(function(a, b) {
    return new Date(b.reviewDate || b.updatedAt || 0) - new Date(a.reviewDate || a.updatedAt || 0);
  });
  return sorted[0];
}

/**
 * Returns one of: 'Current' | 'Due Soon' | 'Overdue' | 'Never Reviewed'
 * Review cycle: annual (12 months). "Due Soon" = 9-12 months since last review.
 */
function VR_reviewStatus_(latestReview) {
  if (!latestReview) return 'Never Reviewed';

  var dateStr = latestReview.reviewDate || latestReview.updatedAt || '';
  if (!dateStr) return 'Never Reviewed';

  var reviewDate = new Date(dateStr);
  if (isNaN(reviewDate.getTime())) return 'Never Reviewed';

  var now       = new Date();
  var monthsAgo = (now - reviewDate) / (1000 * 60 * 60 * 24 * 30.44);

  if (monthsAgo < 9)  return 'Current';
  if (monthsAgo < 12) return 'Due Soon';
  return 'Overdue';
}

/**
 * Normalise risk level to a canonical title-case string.
 * The token service maps vendor.inherentRiskLevel → vendor.riskLevel,
 * so vendor.riskLevel is the primary field here.
 */
function VR_riskLevel_(vendor) {
  var raw = String(
    vendor.riskLevel         ||
    vendor.inherentRiskLevel ||
    vendor.riskTier          ||
    ''
  ).trim();

  var map = {
    critical: 'Critical',
    high:     'High',
    medium:   'Medium',
    low:      'Low',
    unscored: 'Unscored'
  };
  return map[raw.toLowerCase()] || (raw || 'Unknown');
}

function VR_normalizeReview_(review) {
  return {
    id:         review.id         || '',
    reviewDate: review.reviewDate || '',
    status:     review.status     || '',
    updatedAt:  review.updatedAt  || ''
  };
}


// ── Document Library helpers ──────────────────────────────────────────────────

/**
 * Reads the vendor doc library from the configured Google Sheet.
 * Columns (any order, matched by header name):
 *   Vendor Name | Document Title | Document Type | Drive File ID | Valid Until
 */
function VR_getDocLibrary_() {
  var ssId = getConfigValue('VENDOR_DOCS_SPREADSHEET_ID') || APP_CONFIG.VENDOR_DOCS_SPREADSHEET_ID;
  if (!ssId) return [];

  var ss = SpreadsheetApp.openById(ssId);
  var sh = ss.getSheetByName(getConfigValue('VENDOR_DOCS_SHEET_NAME') || APP_CONFIG.VENDOR_DOCS_SHEET_NAME || 'Vendor Docs');
  if (!sh) sh = ss.getSheets()[0];
  if (!sh) return [];

  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];

  var header  = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var colMap  = {
    vendorName:    VR_findCol_(header, ['vendor name', 'vendor']),
    documentTitle: VR_findCol_(header, ['document title', 'title']),
    documentType:  VR_findCol_(header, ['document type', 'type']),
    driveFileId:   VR_findCol_(header, ['drive file id', 'file id', 'drive id']),
    validUntil:    VR_findCol_(header, ['valid until', 'expiry', 'expires'])
  };

  var docs = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var vendorName = colMap.vendorName >= 0 ? String(row[colMap.vendorName] || '').trim() : '';
    if (!vendorName) continue;

    docs.push({
      vendorName:    vendorName,
      documentTitle: colMap.documentTitle >= 0 ? String(row[colMap.documentTitle] || '').trim() : '',
      documentType:  colMap.documentType  >= 0 ? String(row[colMap.documentType]  || 'other').trim() : 'other',
      driveFileId:   colMap.driveFileId   >= 0 ? String(row[colMap.driveFileId]   || '').trim() : '',
      validUntil:    colMap.validUntil    >= 0 ? String(row[colMap.validUntil]    || '').trim() : ''
    });
  }

  return docs.filter(function(d) { return d.driveFileId; });
}

function VR_findDocsForVendor_(library, vendorName) {
  var nameLower = vendorName.toLowerCase();
  return library.filter(function(doc) {
    return doc.vendorName.toLowerCase() === nameLower;
  });
}

function VR_findCol_(header, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var idx = header.indexOf(aliases[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}
