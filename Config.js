/** Config.gs **/

/**
 * Default configuration. Overridable via Script Properties (File > Project properties > Script properties):
 * TOKEN_SERVICE_URL, CLIENT_DB_SPREADSHEET_ID, VENDOR_DOCS_SPREADSHEET_ID,
 * CENTRAL_API_SPREADSHEET_ID, ADMIN_EMAILS (comma-separated emails).
 */
var APP_CONFIG = {
  APP_NAME: 'Workstreet Delivery Workspace',
  TOKEN_SERVICE_URL: 'https://script.google.com/macros/s/AKfycbxrmN6Z6bge7xfVA1sb0EAFFb6-i6wXMkEWAIPEgiWrqCv7jtBMHko_P7IMBwVuSt9M_Q/exec',
  CENTRAL_API_SPREADSHEET_ID: '',
  CENTRAL_API_SHEET_NAME: 'Central API Sheet',
  CLIENT_DB_SPREADSHEET_ID: '16L5coACwK5yVAf3UiGavtqtSjcwOmvXDRN8KUCpNwjQ',
  CLIENT_DB_SHEET_NAME: 'Sheet1',
  VANTA_API_BASE: 'https://api.vanta.com/v1',
  API_PAGE_SIZE: 100,
  RATE_LIMIT_MIN_MS: 400,
  MAX_RETRIES: 6,
  BACKOFF_BASE_MS: 500,
  VENDOR_DOCS_SPREADSHEET_ID: '1xvauzvIuplEwIGjSW65Uy4MeHzIj2kgDDDaRfvczhE8',
  VENDOR_DOCS_SHEET_NAME: 'Vendor Docs',
  BRAND: {
    logoText: 'workstreet',
    productName: 'Workstreet Delivery Workspace'
  }
};

/**
 * Returns a config value. Script Properties override APP_CONFIG_DEFAULTS / APP_CONFIG.
 * @param {string} key - e.g. 'CLIENT_DB_SPREADSHEET_ID', 'TOKEN_SERVICE_URL', 'ADMIN_EMAILS'
 * @returns {string|undefined}
 */
function getConfig(key) {
  if (!key) return undefined;
  try {
    var prop = PropertiesService.getScriptProperties().getProperty(key);
    if (prop !== null && prop !== undefined && String(prop).trim() !== '') {
      return String(prop).trim();
    }
  } catch (e) {
    Logger.log('getConfig(' + key + '): ' + (e && e.message));
  }
  return APP_CONFIG[key] !== undefined ? APP_CONFIG[key] : undefined;
}

/**
 * Returns whether the current user is an admin (for guarding sensitive operations).
 * Uses Script Property ADMIN_EMAILS (comma-separated emails) or falls back to empty = no restriction.
 * @returns {boolean}
 */
function isAdmin() {
  var emails = getConfig('ADMIN_EMAILS');
  if (!emails || String(emails).trim() === '') return true; // no list = allow all (backward compat)
  var user = '';
  try {
    user = Session.getActiveUser().getEmail();
  } catch (e) {
    return false;
  }
  if (!user) return false;
  var list = String(emails).split(',').map(function(s) { return s.trim().toLowerCase(); });
  return list.indexOf(user.toLowerCase()) >= 0;
}

/**
 * Resolved config value for a key (Script Properties override APP_CONFIG).
 * Use this in code so deploy-specific values can be set without editing source.
 */
function getConfigValue(key) {
  var v = getConfig(key);
  return v !== undefined ? v : (APP_CONFIG[key] !== undefined ? APP_CONFIG[key] : '');
}
