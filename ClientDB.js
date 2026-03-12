/** ClientDB.js **/

var DB_COLUMN_MAP = {
  clientName:       ['client', 'client name', 'clientname'],
  clientType:       ['client type', 'clienttype', 'type', 'engagement type'],
  projectPlanLink:  ['project plan link', 'project plan', 'projectplanlink', 'plan link'],
  evidenceDropLink: ['evidence drop folder link', 'evidence drop', 'evidencedroplink', 'evidence folder'],
  cloudSecIncluded: ['workstreet cloudsec', 'cloudsec', 'cloudsecincluded', 'cloud sec'],
  opsLead:          ['ops lead', 'opslead', 'ops_lead', 'operations lead'],
  frameworks:       ['frameworks', 'framework', 'compliance frameworks']
};

var DB_REQUIRED_COLS = [
  { key: 'clientType',       label: 'Client Type',               aliases: DB_COLUMN_MAP.clientType },
  { key: 'projectPlanLink',  label: 'Project Plan Link',         aliases: DB_COLUMN_MAP.projectPlanLink },
  { key: 'evidenceDropLink', label: 'Evidence Drop Folder Link', aliases: DB_COLUMN_MAP.evidenceDropLink },
  { key: 'cloudSecIncluded', label: 'Workstreet CloudSec',       aliases: DB_COLUMN_MAP.cloudSecIncluded },
  { key: 'opsLead',          label: 'Ops Lead',                  aliases: DB_COLUMN_MAP.opsLead },
  { key: 'frameworks',       label: 'Frameworks',                aliases: DB_COLUMN_MAP.frameworks }
];

function WD_getClientMetadata(clientName) {
  if (!clientName || !APP_CONFIG.CLIENT_DB_SPREADSHEET_ID) return {};
  try {
    var ss = SpreadsheetApp.openById(APP_CONFIG.CLIENT_DB_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(APP_CONFIG.CLIENT_DB_SHEET_NAME) || ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return {};

    var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var clientColIdx = WD_dbFindColIdx_(headers, DB_COLUMN_MAP.clientName);

    if (clientColIdx === -1) {
      Logger.log('WD_getClientMetadata: No "Client" column found. Headers: ' + JSON.stringify(data[0]));
      return {};
    }

    for (var i = 1; i < data.length; i++) {
      var rowClient = String(data[i][clientColIdx] || '').trim().toLowerCase();
      if (rowClient === clientName.trim().toLowerCase()) {
        return {
          clientType:       WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.clientType),
          projectPlanLink:  WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.projectPlanLink),
          evidenceDropLink: WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.evidenceDropLink),
          cloudSecIncluded: WD_dbParseBool_(WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.cloudSecIncluded)),
          opsLead:          WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.opsLead),
          frameworks:       WD_dbGetColValue_(data[i], headers, DB_COLUMN_MAP.frameworks)
        };
      }
    }
  } catch(e) {
    Logger.log('WD_getClientMetadata error: ' + e.toString());
  }
  return {};
}

function WD_saveClientMetadata(clientName, data) {
  if (!clientName || !APP_CONFIG.CLIENT_DB_SPREADSHEET_ID) return;
  try {
    var ss = SpreadsheetApp.openById(APP_CONFIG.CLIENT_DB_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(APP_CONFIG.CLIENT_DB_SHEET_NAME) || ss.getSheets()[0];
    var allData = sheet.getDataRange().getValues();

    if (allData.length === 0) {
      sheet.appendRow(['Client', 'Client Type', 'Project Plan Link', 'Evidence Drop Folder Link', 'Workstreet CloudSec', 'Ops Lead', 'Frameworks']);
      allData = sheet.getDataRange().getValues();
    }

    var headers = allData[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var clientColIdx = WD_dbFindColIdx_(headers, DB_COLUMN_MAP.clientName);

    // If no Client column exists, insert one at column A
    if (clientColIdx === -1) {
      sheet.insertColumnBefore(1);
      sheet.getRange(1, 1).setValue('Client');
      // Refresh data after structural change
      allData = sheet.getDataRange().getValues();
      headers = allData[0].map(function(h) { return String(h).trim().toLowerCase(); });
      clientColIdx = 0;
    }

    // Add any missing columns
    DB_REQUIRED_COLS.forEach(function(col) {
      if (WD_dbFindColIdx_(headers, col.aliases) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col.label);
        headers.push(col.label.toLowerCase());
      }
    });

    // Re-read headers after potential additions
    var freshHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h).trim().toLowerCase(); });

    var writeData = {
      clientType:       data.clientType || '',
      projectPlanLink:  data.projectPlanLink || '',
      evidenceDropLink: data.evidenceDropLink || '',
      cloudSecIncluded: data.cloudSecIncluded ? 'TRUE' : 'FALSE',
      opsLead:          data.opsLead || '',
      frameworks:       data.frameworks || ''
    };

    // Find existing row
    var rowIdx = -1;
    for (var i = 1; i < allData.length; i++) {
      if (String(allData[i][clientColIdx] || '').trim().toLowerCase() === clientName.trim().toLowerCase()) {
        rowIdx = i + 1; // 1-based sheet row
        break;
      }
    }

    if (rowIdx === -1) {
      var newRow = new Array(freshHeaders.length).fill('');
      var nameIdx = WD_dbFindColIdx_(freshHeaders, DB_COLUMN_MAP.clientName);
      newRow[nameIdx !== -1 ? nameIdx : clientColIdx] = clientName;
      DB_REQUIRED_COLS.forEach(function(col) {
        var idx = WD_dbFindColIdx_(freshHeaders, col.aliases);
        if (idx !== -1) newRow[idx] = writeData[col.key];
      });
      sheet.appendRow(newRow);
    } else {
      DB_REQUIRED_COLS.forEach(function(col) {
        var idx = WD_dbFindColIdx_(freshHeaders, col.aliases);
        if (idx !== -1) sheet.getRange(rowIdx, idx + 1).setValue(writeData[col.key]);
      });
    }
  } catch(e) {
    Logger.log('WD_saveClientMetadata error: ' + e.toString());
  }
}

function WD_dbFindColIdx_(headers, aliases) {
  // 1. Exact match
  for (var i = 0; i < aliases.length; i++) {
    var idx = headers.indexOf(aliases[i].toLowerCase());
    if (idx !== -1) return idx;
  }
  // 2. Substring match: header contains any alias keyword
  for (var j = 0; j < aliases.length; j++) {
    var keyword = aliases[j].toLowerCase();
    for (var k = 0; k < headers.length; k++) {
      if (headers[k] && headers[k].indexOf(keyword) !== -1) return k;
    }
  }
  return -1;
}

/**
 * Run this from the Apps Script editor to see what headers are in your DB sheet.
 * Helps diagnose column-mapping issues.
 */
function WD_debugClientDB() {
  var ss = SpreadsheetApp.openById(APP_CONFIG.CLIENT_DB_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(APP_CONFIG.CLIENT_DB_SHEET_NAME) || ss.getSheets()[0];
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Logger.log('Sheet: ' + sheet.getName());
  Logger.log('Headers: ' + JSON.stringify(headers));
  Logger.log('Row count: ' + (sheet.getLastRow() - 1));
}

function WD_dbGetColValue_(row, headers, aliases) {
  var idx = WD_dbFindColIdx_(headers, aliases);
  return (idx !== -1 && idx < row.length) ? String(row[idx] || '').trim() : '';
}

function WD_dbParseBool_(val) {
  if (!val) return false;
  var lower = val.toLowerCase();
  return lower === 'true' || lower === 'yes' || lower === '1';
}
