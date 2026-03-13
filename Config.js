/** Config.gs **/

const APP_CONFIG = {
  APP_NAME: 'Workstreet Delivery Workspace',
  TOKEN_SERVICE_URL: 'https://script.google.com/macros/s/AKfycbxrmN6Z6bge7xfVA1sb0EAFFb6-i6wXMkEWAIPEgiWrqCv7jtBMHko_P7IMBwVuSt9M_Q/exec',

  // Fallback only if the token service does not yet support ?action=clients
  // Leave blank if you do not want local fallback.
  CENTRAL_API_SPREADSHEET_ID: '',
  CENTRAL_API_SHEET_NAME: 'Central API Sheet',

  // Client metadata DB (project plan links, evidence drop, ops lead, frameworks, etc.)
  CLIENT_DB_SPREADSHEET_ID: '16L5coACwK5yVAf3UiGavtqtSjcwOmvXDRN8KUCpNwjQ',
  CLIENT_DB_SHEET_NAME: 'Sheet1',

  VANTA_API_BASE: 'https://api.vanta.com/v1',
  API_PAGE_SIZE: 100,
  RATE_LIMIT_MIN_MS: 400,
  MAX_RETRIES: 6,
  BACKOFF_BASE_MS: 500,

  BRAND: {
    logoText: 'workstreet',
    productName: 'Workstreet Delivery Workspace'
  }
};