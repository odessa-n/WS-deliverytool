/** ClientManagement.js **/

/**
 * Returns active client names from the DB only (no token service call).
 * Clients with clientStatus 'Active' (or empty/unset, which defaults to Active) are included.
 * Used by Trust Ops dropdown and Test Monitor refresh.
 */
function WD_getActiveClients() {
  var dbMap = WD_readAllClientDb_();
  var active = [];
  Object.keys(dbMap).forEach(function(key) {
    var row    = dbMap[key];
    var status = (row.clientStatus || '').trim().toLowerCase();
    if (!status || status === 'active') {
      active.push(row.clientName);
    }
  });
  return active.sort();
}

/**
 * Returns all clients from the Central API (token service), merged with DB metadata.
 * Used by the Client Management UI to show the full list with editable fields.
 * Clients not yet in the DB are returned with defaults (clientStatus = 'Active').
 */
function CM_getAllClientsWithMetadata() {
  var allClients = WD_getClients();  // token service (authoritative client list)
  var dbMap      = WD_readAllClientDb_();

  return allClients.map(function(clientName) {
    var key = clientName.trim().toLowerCase();
    var db  = dbMap[key] || {};
    return {
      clientName:      clientName,
      clientType:      db.clientType      || '',
      projectPlanLink: db.projectPlanLink || '',
      evidenceDropLink:db.evidenceDropLink|| '',
      cloudSecIncluded:db.cloudSecIncluded|| false,
      opsLead:         db.opsLead         || '',
      frameworks:      db.frameworks      || '',
      clientStatus:    db.clientStatus    || 'Active'
    };
  });
}

/**
 * Saves client metadata from the Client Management form.
 * Thin wrapper around WD_saveClientMetadata.
 */
function CM_saveClientData(payload) {
  payload = payload || {};
  var clientName = String(payload.clientName || '').trim();
  if (!clientName) throw new Error('Client name is required.');

  WD_saveClientMetadata(clientName, {
    clientType:      payload.clientType      || '',
    projectPlanLink: payload.projectPlanLink || '',
    evidenceDropLink:payload.evidenceDropLink|| '',
    cloudSecIncluded:!!payload.cloudSecIncluded,
    opsLead:         payload.opsLead         || '',
    frameworks:      payload.frameworks      || '',
    clientStatus:    payload.clientStatus    || 'Active'
  });

  return { success: true };
}
