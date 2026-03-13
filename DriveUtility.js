/** DriveUtility.gs **/
/**
 * Drive Utility — Rename, Logo Only, Convert to PDF, Doc History, Folder Parser
 * Ported from WS-driveutility for integration into Workstreet Delivery Workspace.
 */

// ── Shared Helpers ────────────────────────────────────────────────────────────

function DU_extractFolderId_(url) {
  var s = String(url);
  var m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  throw new Error('Could not extract folder ID from: ' + url);
}

function DU_extractFileId_(urlOrId) {
  var s = String(urlOrId);
  var m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  throw new Error('Could not extract file ID from: ' + urlOrId);
}

function DU_escapeRegExp_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function DU_normalizeFileUrls_(fileUrls) {
  if (!fileUrls) return [];
  if (Array.isArray(fileUrls)) {
    return fileUrls.map(function(x) { return String(x || '').trim(); }).filter(Boolean).map(DU_extractFileId_);
  }
  return String(fileUrls).split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean).map(DU_extractFileId_);
}

// ── 1. Rename Files ───────────────────────────────────────────────────────────

function DU_runRename(payload) {
  if (!payload || !payload.folderUrl) throw new Error('Folder URL is required.');

  var folderId = DU_extractFolderId_(payload.folderUrl);
  var rootFolder = DriveApp.getFolderById(folderId);
  var includeSubfolders = !!payload.includeSubfolders;
  var renameFoldersToo = !!payload.renameFoldersToo;
  var caseInsensitive = !!payload.caseInsensitive;
  var dryRun = !!payload.dryRun;

  var replacements = [];
  if (payload.mode === 'single') {
    if (!payload.findText) throw new Error('Find text is required.');
    replacements = [{ find: payload.findText, replace: payload.replaceText || '' }];
  } else if (payload.mode === 'multi') {
    replacements = DU_parseReplacementPairs_(payload.multiPairs || '');
    if (!replacements.length) throw new Error('No valid pairs found. Use: find=>replace, find2=>replace2');
  } else {
    throw new Error('Invalid mode.');
  }

  var visitedFolderIds = new Set();
  var changes = [];
  var scannedFiles = 0;
  var scannedFolders = 0;

  var replacers = replacements.map(function(r) {
    return { find: r.find, replace: r.replace, regex: caseInsensitive ? new RegExp(DU_escapeRegExp_(r.find), 'gi') : null };
  });

  function applyAll_(name) {
    var next = name;
    for (var i = 0; i < replacers.length; i++) {
      var r = replacers[i];
      next = caseInsensitive ? next.replace(r.regex, r.replace) : next.split(r.find).join(r.replace);
    }
    return next;
  }

  function processFolder_(folder) {
    var fid = folder.getId();
    if (visitedFolderIds.has(fid)) return;
    visitedFolderIds.add(fid);
    scannedFolders++;

    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      scannedFiles++;
      var oldName = file.getName();
      var newName = applyAll_(oldName);
      if (newName !== oldName) {
        changes.push({ type: 'FILE', oldName: oldName, newName: newName, id: file.getId() });
        if (!dryRun) file.setName(newName);
      }
    }

    var subfolders = folder.getFolders();
    while (subfolders.hasNext()) {
      var sub = subfolders.next();
      if (renameFoldersToo) {
        var oldFolderName = sub.getName();
        var newFolderName = applyAll_(oldFolderName);
        if (newFolderName !== oldFolderName) {
          changes.push({ type: 'FOLDER', oldName: oldFolderName, newName: newFolderName, id: sub.getId() });
          if (!dryRun) sub.setName(newFolderName);
        }
      }
      if (includeSubfolders) processFolder_(sub);
    }
  }

  processFolder_(rootFolder);

  return {
    dryRun: dryRun,
    rootFolderName: rootFolder.getName(),
    scannedFolders: scannedFolders,
    scannedFiles: scannedFiles,
    changesCount: changes.length,
    changes: changes.slice(0, 200)
  };
}

function DU_parseReplacementPairs_(input) {
  return (input || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean).map(function(pair) {
    var parts = pair.split('=>');
    if (parts.length < 2) return null;
    var find = (parts[0] || '').trim();
    var replace = parts.slice(1).join('=>').trim();
    if (!find) return null;
    return { find: find, replace: replace };
  }).filter(Boolean);
}

// ── 2. Logo Only ──────────────────────────────────────────────────────────────

function DU_runLogoOnly(payload) {
  if (!payload) throw new Error('Payload is required.');
  var mode = String(payload.mode || 'folder').trim();
  var dryRun = !!payload.dryRun;

  if (!payload.logoFileUrl) throw new Error('Logo file URL/ID is required.');
  var logoFileId = DU_extractFileId_(payload.logoFileUrl);
  var blob = DriveApp.getFileById(logoFileId).getBlob();
  var logoConfig = { blob: blob, maxHeightIn: 0.75, replaceLogo: !!payload.replaceLogo };

  if (mode === 'folder') {
    if (!payload.folderUrl) throw new Error('Folder URL is required.');
    var folderId = DU_extractFolderId_(payload.folderUrl);
    var rootFolder = DriveApp.getFolderById(folderId);
    return DU_processDocsInFolder_({ rootFolder: rootFolder, includeSubfolders: !!payload.includeSubfolders, dryRun: dryRun, replacements: [], logo: logoConfig });
  }

  if (mode === 'files') {
    var ids = DU_normalizeFileUrls_(payload.fileUrls);
    if (!ids.length) throw new Error('Provide at least one file URL/ID.');
    return DU_applyLogoToFiles_({ docIds: ids, dryRun: dryRun, logo: logoConfig });
  }

  throw new Error("Invalid mode. Use 'folder' or 'files'.");
}

function DU_applyLogoToFiles_(opts) {
  var docIds = opts.docIds, dryRun = opts.dryRun, logo = opts.logo;
  var changes = [], scannedFiles = 0, scannedDocs = 0;

  for (var i = 0; i < docIds.length; i++) {
    scannedFiles++;
    var id = docIds[i];
    var f = DriveApp.getFileById(id);
    var url = 'https://docs.google.com/document/d/' + id + '/edit';

    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) {
      changes.push({ type: 'DOC', id: id, name: f.getName(), url: url, logoAction: 'skipped', message: 'Not a Google Doc.' });
      continue;
    }
    scannedDocs++;

    try {
      var doc = DocumentApp.openById(id);
      var header = doc.getHeader() || doc.addHeader();
      var record = { type: 'DOC', id: id, name: f.getName(), url: url, replacements: [], totalReplacements: 0, logoAction: 'none' };

      if (dryRun) {
        record.logoAction = logo.replaceLogo ? 'would replace/insert' : 'would insert';
        doc.saveAndClose();
      } else {
        if (logo.replaceLogo) DU_clearHeaderImages_(header);
        var meta = DU_insertLogo_(header, logo.blob, logo.maxHeightIn);
        record.logoAction = logo.replaceLogo ? 'replaced/inserted' : 'inserted';
        record.logo = meta;
        doc.saveAndClose();
      }
      changes.push(record);
    } catch (e) {
      changes.push({ type: 'DOC', id: id, name: f.getName(), url: url, logoAction: 'error', message: e.message || String(e) });
    }
  }

  return { dryRun: dryRun, mode: 'files', scannedFiles: scannedFiles, scannedDocs: scannedDocs, changesCount: changes.length, changes: changes };
}

function DU_processDocsInFolder_(opts) {
  var rootFolder = opts.rootFolder, includeSubfolders = opts.includeSubfolders, dryRun = opts.dryRun;
  var replacements = opts.replacements || [], logo = opts.logo;
  var visitedFolderIds = new Set(), changes = [];
  var scannedFiles = 0, scannedFolders = 0, scannedDocs = 0;

  function countOccurrences_(text, literal) {
    var m = text.match(new RegExp(DU_escapeRegExp_(literal), 'g'));
    return m ? m.length : 0;
  }

  function processFolder_(folder) {
    var fid = folder.getId();
    if (visitedFolderIds.has(fid)) return;
    visitedFolderIds.add(fid);
    scannedFolders++;

    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      scannedFiles++;
      if (file.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
      scannedDocs++;

      var docId = file.getId();
      var docUrl = 'https://docs.google.com/document/d/' + docId + '/edit';
      var doc = DocumentApp.openById(docId);
      var body = doc.getBody();
      var originalText = body.getText();

      var record = { type: 'DOC', id: docId, name: file.getName(), url: docUrl, replacements: [], totalReplacements: 0, logoAction: 'none' };

      for (var i = 0; i < replacements.length; i++) {
        var r = replacements[i];
        var cnt = countOccurrences_(originalText, r.find);
        if (cnt > 0) {
          record.replacements.push({ find: r.find, replace: r.replace, count: cnt });
          record.totalReplacements += cnt;
        }
      }

      var logoWouldChange = false;
      if (logo && logo.blob) {
        logoWouldChange = true;
        if (!dryRun) {
          var h = doc.getHeader() || doc.addHeader();
          if (logo.replaceLogo) DU_clearHeaderImages_(h);
          var logoMeta = DU_insertLogo_(h, logo.blob, logo.maxHeightIn);
          record.logoAction = logo.replaceLogo ? 'replaced/inserted' : 'inserted';
          record.logo = logoMeta;
        } else {
          record.logoAction = logo.replaceLogo ? 'would replace/insert' : 'would insert';
        }
      }

      if ((record.totalReplacements > 0) || logoWouldChange) {
        changes.push(record);
        if (!dryRun) {
          for (var j = 0; j < replacements.length; j++) {
            body.replaceText(DU_escapeRegExp_(replacements[j].find), replacements[j].replace);
          }
        }
      }
      doc.saveAndClose();
    }

    if (!includeSubfolders) return;
    var subs = folder.getFolders();
    while (subs.hasNext()) processFolder_(subs.next());
  }

  processFolder_(rootFolder);

  return {
    dryRun: dryRun,
    rootFolderName: rootFolder.getName(),
    scannedFolders: scannedFolders,
    scannedFiles: scannedFiles,
    scannedDocs: scannedDocs,
    changesCount: changes.length,
    changes: changes
  };
}

function DU_clearHeaderImages_(header) {
  for (var i = header.getNumChildren() - 1; i >= 0; i--) {
    var child = header.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var p = child.asParagraph();
      for (var j = p.getNumChildren() - 1; j >= 0; j--) {
        var el = p.getChild(j);
        if (el.getType && el.getType() === DocumentApp.ElementType.INLINE_IMAGE) el.removeFromParent();
      }
    }
  }
}

function DU_insertLogo_(header, blob, maxHeightIn) {
  var maxH = Math.round(maxHeightIn * 72);
  var p;
  if (header.getNumChildren() > 0 && header.getChild(0).getType() === DocumentApp.ElementType.PARAGRAPH) {
    p = header.getChild(0).asParagraph();
  } else {
    p = header.insertParagraph(0, '');
  }
  p.setAlignment(DocumentApp.HorizontalAlignment.LEFT);
  var img = p.insertInlineImage(0, blob);
  var h0 = img.getHeight(), w0 = img.getWidth();
  if (h0 && w0 && h0 > maxH) {
    var scale = maxH / h0;
    img.setHeight(Math.round(h0 * scale));
    img.setWidth(Math.round(w0 * scale));
  } else if (!h0) {
    img.setHeight(maxH);
  }
  return { finalHeight: img.getHeight(), finalWidth: img.getWidth() };
}

// ── 3. Convert to PDF ─────────────────────────────────────────────────────────

function DU_runPdfExport(payload) {
  if (!payload) throw new Error('Payload is required.');
  var mode = (payload.mode || 'folder').trim();
  var dryRun = !!payload.dryRun;
  var overwrite = !!payload.overwrite;
  var includeSubfolders = !!payload.includeSubfolders;
  var outFolder = DU_resolveOutputFolder_(payload);

  if (mode === 'folder') {
    if (!payload.folderUrl) throw new Error('Folder URL is required.');
    var folderId = DU_extractFolderId_(payload.folderUrl);
    var rootFolder = DriveApp.getFolderById(folderId);
    return DU_exportFolderToPdf_({ rootFolder: rootFolder, includeSubfolders: includeSubfolders, outFolder: outFolder, dryRun: dryRun, overwrite: overwrite });
  }

  if (mode === 'files') {
    var fileIds = DU_normalizeFileUrls_(payload.fileUrls);
    if (!fileIds.length) throw new Error('Provide at least one file URL/ID.');
    return DU_exportFilesToPdf_({ fileIds: fileIds, outFolder: outFolder, dryRun: dryRun, overwrite: overwrite });
  }

  throw new Error("Invalid mode. Use 'folder' or 'files'.");
}

function DU_resolveOutputFolder_(payload) {
  var outUrl = (payload.outputFolderUrl || '').trim();
  if (outUrl) return DriveApp.getFolderById(DU_extractFolderId_(outUrl));
  var name = (payload.outputFolderName || '').trim();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'yyyyMMdd-HHmmss');
  return DriveApp.getRootFolder().createFolder(name || ('PDF Export - ' + stamp));
}

function DU_exportFolderToPdf_(opts) {
  var rootFolder = opts.rootFolder, outFolder = opts.outFolder;
  var includeSubfolders = opts.includeSubfolders, dryRun = opts.dryRun, overwrite = opts.overwrite;
  var visited = new Set(), results = [];
  var scannedFolders = 0, scannedFiles = 0;

  function walk_(folder) {
    var fid = folder.getId();
    if (visited.has(fid)) return;
    visited.add(fid);
    scannedFolders++;
    var files = folder.getFiles();
    while (files.hasNext()) {
      scannedFiles++;
      results.push(DU_exportOneToPdf_(files.next(), outFolder, dryRun, overwrite));
    }
    if (!includeSubfolders) return;
    var subs = folder.getFolders();
    while (subs.hasNext()) walk_(subs.next());
  }

  walk_(rootFolder);
  var summary = DU_summarizePdf_(results);
  return Object.assign({
    dryRun: dryRun,
    mode: 'folder',
    rootFolderName: rootFolder.getName(),
    outputFolderName: outFolder.getName(),
    outputFolderUrl: 'https://drive.google.com/drive/folders/' + outFolder.getId(),
    scannedFolders: scannedFolders,
    scannedFiles: scannedFiles,
    items: results.slice(0, 200)
  }, summary);
}

function DU_exportFilesToPdf_(opts) {
  var fileIds = opts.fileIds, outFolder = opts.outFolder, dryRun = opts.dryRun, overwrite = opts.overwrite;
  var results = [];
  for (var i = 0; i < fileIds.length; i++) {
    results.push(DU_exportOneToPdf_(DriveApp.getFileById(fileIds[i]), outFolder, dryRun, overwrite));
  }
  var summary = DU_summarizePdf_(results);
  return Object.assign({
    dryRun: dryRun,
    mode: 'files',
    outputFolderName: outFolder.getName(),
    outputFolderUrl: 'https://drive.google.com/drive/folders/' + outFolder.getId(),
    scannedFiles: fileIds.length,
    items: results.slice(0, 200)
  }, summary);
}

function DU_exportOneToPdf_(file, outFolder, dryRun, overwrite) {
  var id = file.getId(), name = file.getName(), mime = file.getMimeType();
  var pdfName = String(name).replace(/\.pdf$/i, '') + '.pdf';
  var record = { id: id, name: name, status: 'skipped', message: '', pdfUrl: null };

  try {
    if (mime === MimeType.PDF || mime === 'application/pdf') {
      record.status = dryRun ? 'skipped' : 'copied';
      record.message = dryRun ? 'Would copy existing PDF.' : 'Copied existing PDF.';
      if (!dryRun) {
        if (overwrite) DU_removeExistingByName_(outFolder, pdfName);
        var copied = file.makeCopy(pdfName, outFolder);
        record.pdfUrl = 'https://drive.google.com/file/d/' + copied.getId() + '/view';
      }
      return record;
    }

    var isExportable = (mime === MimeType.GOOGLE_DOCS || mime === MimeType.GOOGLE_SHEETS ||
      mime === MimeType.GOOGLE_SLIDES || mime === 'application/vnd.google-apps.drawing');

    if (isExportable) {
      record.status = dryRun ? 'skipped' : 'converted';
      record.message = dryRun ? 'Would export to PDF.' : 'Exported to PDF.';
      if (!dryRun) {
        if (overwrite) DU_removeExistingByName_(outFolder, pdfName);
        var blob;
        try { blob = Drive.Files.export(id, MimeType.PDF); } catch (e2) { blob = file.getBlob().getAs(MimeType.PDF); }
        blob.setName(pdfName);
        var created = outFolder.createFile(blob);
        record.pdfUrl = 'https://drive.google.com/file/d/' + created.getId() + '/view';
      }
      return record;
    }

    try {
      var pdfBlob = file.getBlob().getAs(MimeType.PDF);
      record.status = dryRun ? 'skipped' : 'converted';
      record.message = dryRun ? 'Would convert to PDF.' : 'Converted to PDF.';
      if (!dryRun) {
        if (overwrite) DU_removeExistingByName_(outFolder, pdfName);
        pdfBlob.setName(pdfName);
        var c2 = outFolder.createFile(pdfBlob);
        record.pdfUrl = 'https://drive.google.com/file/d/' + c2.getId() + '/view';
      }
    } catch (e3) {
      record.status = 'skipped';
      record.message = 'Unsupported for PDF conversion: ' + mime;
    }
  } catch (e) {
    record.status = 'error';
    record.message = e.message || String(e);
  }
  return record;
}

function DU_summarizePdf_(items) {
  var out = { convertedCount: 0, copiedCount: 0, skippedCount: 0, errorCount: 0 };
  for (var i = 0; i < items.length; i++) {
    var s = items[i].status;
    if (s === 'converted') out.convertedCount++;
    else if (s === 'copied') out.copiedCount++;
    else if (s === 'error') out.errorCount++;
    else out.skippedCount++;
  }
  return out;
}

function DU_removeExistingByName_(folder, filename) {
  var it = folder.getFilesByName(filename);
  while (it.hasNext()) it.next().setTrashed(true);
}

// ── 4. Update Doc History ─────────────────────────────────────────────────────

function DU_runDocHistoryUpdate(payload) {
  if (!payload) throw new Error('Payload is required.');
  var mode = String(payload.mode || 'folder').trim();
  var includeSubfolders = !!payload.includeSubfolders;
  var dryRun = !!payload.dryRun;
  var version = (payload.version || '').trim();
  if (!version) throw new Error('Version is required (e.g., 1.2).');
  var addIfMissing = !!payload.addIfMissing;
  var tz = (payload.timezone || Session.getScriptTimeZone() || 'GMT').trim();
  var dateFormat = (payload.dateFormat || 'M/d/yy').trim();

  // Support multi-field array (new) or single field/value (legacy)
  var fields;
  if (payload.fields && Array.isArray(payload.fields) && payload.fields.length) {
    fields = payload.fields;
  } else {
    var field = (payload.field || '').trim();
    if (!field) throw new Error('At least one field is required.');
    fields = [{ field: field, value: payload.value !== undefined ? String(payload.value) : '' }];
  }

  var ctx = { dryRun: dryRun, version: version, fields: fields, addIfMissing: addIfMissing, tz: tz, dateFormat: dateFormat };

  if (mode === 'folder') {
    if (!payload.folderUrl) throw new Error('Folder URL is required.');
    var folderId = DU_extractFolderId_(payload.folderUrl);
    var rootFolder = DriveApp.getFolderById(folderId);
    return DU_updateDocHistoryInFolder_(Object.assign({ rootFolder: rootFolder, includeSubfolders: includeSubfolders }, ctx));
  }

  if (mode === 'files') {
    var ids = DU_normalizeFileUrls_(payload.fileUrls);
    if (!ids.length) throw new Error('Provide at least one file URL/ID.');
    return DU_updateDocHistoryInFiles_(Object.assign({ fileIds: ids }, ctx));
  }

  throw new Error("Invalid mode. Use 'folder' or 'files'.");
}

function DU_updateDocHistoryInFolder_(opts) {
  var rootFolder = opts.rootFolder, includeSubfolders = opts.includeSubfolders;
  var visited = new Set(), changes = [];
  var scannedFolders = 0, scannedFiles = 0, scannedDocs = 0;

  function walk_(folder) {
    var fid = folder.getId();
    if (visited.has(fid)) return;
    visited.add(fid);
    scannedFolders++;
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      scannedFiles++;
      if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
      scannedDocs++;
      var rec = DU_updateDocHistoryInDoc_(f.getId(), opts);
      if (rec.didChange || rec.status === 'error') changes.push(rec);
    }
    if (!includeSubfolders) return;
    var subs = folder.getFolders();
    while (subs.hasNext()) walk_(subs.next());
  }

  walk_(rootFolder);
  return DU_buildDocHistorySummary_({ dryRun: opts.dryRun, mode: 'folder', rootFolderName: rootFolder.getName(), scannedFolders: scannedFolders, scannedFiles: scannedFiles, scannedDocs: scannedDocs, changes: changes });
}

function DU_updateDocHistoryInFiles_(opts) {
  var fileIds = opts.fileIds, changes = [];
  var scannedFiles = 0, scannedDocs = 0;
  for (var i = 0; i < fileIds.length; i++) {
    scannedFiles++;
    var f = DriveApp.getFileById(fileIds[i]);
    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) {
      changes.push({ status: 'skipped', didChange: false, id: fileIds[i], name: f.getName(), message: 'Not a Google Doc.' });
      continue;
    }
    scannedDocs++;
    var rec = DU_updateDocHistoryInDoc_(fileIds[i], opts);
    if (rec.didChange || rec.status === 'error' || rec.status === 'skipped') changes.push(rec);
  }
  return DU_buildDocHistorySummary_({ dryRun: opts.dryRun, mode: 'files', scannedFiles: scannedFiles, scannedDocs: scannedDocs, changes: changes });
}

function DU_updateDocHistoryInDoc_(docId, ctx) {
  var dryRun = ctx.dryRun, version = ctx.version, fields = ctx.fields;
  var addIfMissing = ctx.addIfMissing, tz = ctx.tz, dateFormat = ctx.dateFormat;
  var file = DriveApp.getFileById(docId);
  var record = {
    status: 'skipped', didChange: false, id: docId,
    name: file.getName(),
    url: 'https://docs.google.com/document/d/' + docId + '/edit',
    message: '', tableFound: false, fieldUpdates: []
  };

  try {
    var doc = DocumentApp.openById(docId);
    var body = doc.getBody();
    var found = DU_findDocumentHistoryTable_(body);

    if (!found) {
      record.message = 'No Document History table found.';
      doc.saveAndClose();
      return record;
    }

    var table = found.table, headerMap = found.headerMap;
    record.tableFound = true;

    var rowIndex = DU_findVersionRowIndex_(table, version);
    var targetRow = rowIndex;

    if (targetRow == null) {
      if (!addIfMissing) {
        record.message = 'Version "' + version + '" not found.';
        doc.saveAndClose();
        return record;
      }
      targetRow = table.getNumRows();
      if (!dryRun) {
        var newRow = table.appendTableRow();
        var numCols = table.getRow(0).getNumCells();
        while (newRow.getNumCells() < numCols) newRow.appendTableCell('');
        newRow.getCell(0).setText(version);
      }
      record.message = 'Version "' + version + '" ' + (dryRun ? 'would be added.' : 'added.');
    }

    if (!dryRun && table.getRow(targetRow).getCell(0).getText().trim() !== version) {
      table.getRow(targetRow).getCell(0).setText(version);
    }

    // Update each field in one pass
    for (var i = 0; i < fields.length; i++) {
      var fieldName = fields[i].field;
      var valueRaw = fields[i].value;

      var colIndex = DU_resolveFieldColumnIndex_(headerMap, fieldName);
      if (colIndex == null) {
        record.fieldUpdates.push({ field: fieldName, status: 'skipped', message: 'Column not found' });
        continue;
      }

      var cell = table.getRow(targetRow).getCell(colIndex);
      var oldText = cell.getText();
      var newText = DU_normalizeFieldValue_(fieldName, valueRaw, tz, dateFormat);

      if (oldText === newText) {
        record.fieldUpdates.push({ field: fieldName, status: 'unchanged', oldValue: oldText, newValue: newText });
        continue;
      }

      if (!dryRun) cell.setText(newText);
      record.fieldUpdates.push({ field: fieldName, status: dryRun ? 'preview' : 'updated', oldValue: oldText, newValue: newText });
      record.didChange = true;
    }

    record.status = record.didChange ? (dryRun ? 'preview' : 'updated') : 'skipped';
    if (!record.message && !record.didChange) record.message = 'No changes needed.';

    doc.saveAndClose();
    return record;

  } catch (e) {
    record.status = 'error';
    record.message = e.message || String(e);
    return record;
  }
}

function DU_findDocumentHistoryTable_(body) {
  var tables = body.getTables();
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i];
    if (t.getNumRows() < 2) continue;
    var headerMap = DU_buildHeaderMap_(t.getRow(0));
    var keys = Object.keys(headerMap);
    if (keys.indexOf('version') !== -1 && keys.indexOf('approved by') !== -1) return { table: t, headerMap: headerMap };
  }

  var n = body.getNumChildren();
  for (var j = 0; j < n; j++) {
    var el = body.getChild(j);
    if (el.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var txt = el.asParagraph().getText().trim().toLowerCase();
      if (txt.indexOf('document history') !== -1) {
        for (var k = j + 1; k < Math.min(n, j + 8); k++) {
          var el2 = body.getChild(k);
          if (el2.getType() === DocumentApp.ElementType.TABLE) {
            var t2 = el2.asTable();
            if (t2.getNumRows() < 2) continue;
            var hm = DU_buildHeaderMap_(t2.getRow(0));
            if (Object.keys(hm).indexOf('version') !== -1) return { table: t2, headerMap: hm };
          }
        }
      }
    }
  }
  return null;
}

function DU_buildHeaderMap_(headerRow) {
  var map = {};
  var cells = headerRow.getNumCells();
  for (var c = 0; c < cells; c++) {
    var key = headerRow.getCell(c).getText().trim().toLowerCase();
    if (key) map[key] = c;
  }
  return map;
}

function DU_resolveFieldColumnIndex_(headerMap, field) {
  var f = field.trim().toLowerCase();
  if (headerMap.hasOwnProperty(f)) return headerMap[f];
  var aliases = { 'writtenby': 'written by', 'approvedby': 'approved by', 'ver': 'version', 'desc': 'description' };
  var normalized = f.replace(/\s+/g, '');
  if (aliases[normalized] && headerMap.hasOwnProperty(aliases[normalized])) return headerMap[aliases[normalized]];
  for (var k in headerMap) { if (k.indexOf(f) !== -1) return headerMap[k]; }
  return null;
}

function DU_findVersionRowIndex_(table, version) {
  var target = version.trim();
  for (var r = 1; r < table.getNumRows(); r++) {
    if (table.getRow(r).getCell(0).getText().trim() === target) return r;
  }
  return null;
}

function DU_normalizeFieldValue_(field, valueRaw, tz, dateFormat) {
  var f = field.trim().toLowerCase();
  if (f === 'date') {
    var s = String(valueRaw || '').trim();
    if (!s) return '';
    var d;
    var parts = s.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
    } else {
      var parsed = new Date(s);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) return s;
    return Utilities.formatDate(d, tz || 'GMT', dateFormat || 'M/d/yy');
  }
  return String(valueRaw !== null && valueRaw !== undefined ? valueRaw : '');
}

function DU_buildDocHistorySummary_(res) {
  var changes = res.changes || [];
  var updated = 0, preview = 0, skipped = 0, errors = 0;
  for (var i = 0; i < changes.length; i++) {
    var s = changes[i].status;
    if (s === 'updated') updated++;
    else if (s === 'preview') preview++;
    else if (s === 'error') errors++;
    else skipped++;
  }
  return Object.assign({}, res, { updatedCount: updated, previewCount: preview, skippedCount: skipped, errorCount: errors, changesCount: changes.length });
}

// ── 5. Folder Parser ──────────────────────────────────────────────────────────

function DU_runFolderParser(payload) {
  if (!payload || !payload.folderUrl) throw new Error('Folder URL is required.');
  var folderId = DU_extractFolderId_(payload.folderUrl);
  var rootFolder = DriveApp.getFolderById(folderId);
  var includeSubfolders = !!payload.includeSubfolders;

  var docs = DU_collectDocsForParser_(rootFolder, includeSubfolders);
  var rows = [];

  for (var d = 0; d < docs.length; d++) {
    var docInfo = docs[d];
    var docId = docInfo.id;
    var policyName = docInfo.name;

    var comments = DU_getDocComments_(docId);
    var commentsStr = comments.map(function(c) { return c.author + ' - ' + c.content; }).join('\n');

    try {
      var doc = DocumentApp.openById(docId);
      var body = doc.getBody();
      var found = DU_findDocumentHistoryTable_(body);
      var historyRows = found ? DU_extractHistoryRows_(found.table, found.headerMap) : null;
      doc.saveAndClose();

      if (historyRows && historyRows.length > 0) {
        for (var h = 0; h < historyRows.length; h++) {
          var hr = historyRows[h];
          rows.push({ policyName: policyName, version: hr.version, date: hr.date, description: hr.description, writtenBy: hr.writtenBy, approvedBy: hr.approvedBy, comments: commentsStr });
        }
      } else {
        rows.push({ policyName: policyName, version: '', date: '', description: '', writtenBy: '', approvedBy: '', comments: commentsStr });
      }
    } catch (e) {
      rows.push({ policyName: policyName, version: '', date: '', description: '', writtenBy: '', approvedBy: '', comments: 'Error: ' + (e.message || String(e)) });
    }
  }

  // Output folder
  var outputFolder = rootFolder;
  if (payload.outputFolderUrl && String(payload.outputFolderUrl).trim()) {
    outputFolder = DriveApp.getFolderById(DU_extractFolderId_(payload.outputFolderUrl.trim()));
  }

  // Sheet name: [Client] Policy Review (Year)
  var tz = Session.getScriptTimeZone() || 'GMT';
  var year = Utilities.formatDate(new Date(), tz, 'yyyy');
  var clientName = (payload.clientName || '').trim();
  var defaultName = clientName ? (clientName + ' Policy Review (' + year + ')') : ('Policy Review (' + year + ')');
  var sheetName = (payload.sheetName || '').trim() || defaultName;

  var ss = SpreadsheetApp.create(sheetName);
  var ssFile = DriveApp.getFileById(ss.getId());
  outputFolder.addFile(ssFile);
  DriveApp.getRootFolder().removeFile(ssFile);

  var sheet = ss.getActiveSheet();
  sheet.setName('Policy Register');

  var headers = ['#', 'Policy Name', 'Version Number', 'Date', 'Description', 'Written by', 'Approved by', 'Comments'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4a86e8');
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  if (rows.length > 0) {
    var data = rows.map(function(r, i) {
      return [i + 1, r.policyName, r.version, r.date, r.description, r.writtenBy, r.approvedBy, r.comments];
    });
    sheet.getRange(2, 1, data.length, headers.length).setValues(data);
    sheet.getRange(2, 8, data.length, 1).setWrap(true);
    for (var i = 0; i < rows.length; i++) {
      sheet.getRange(i + 2, 1, 1, headers.length).setBackground(i % 2 === 0 ? '#f3f8ff' : '#ffffff');
    }
  }

  sheet.autoResizeColumns(1, headers.length - 1);
  sheet.setColumnWidth(8, 350);

  return { docsScanned: docs.length, rowsCreated: rows.length, sheetName: sheetName, sheetUrl: ss.getUrl(), sheetId: ss.getId() };
}

function DU_collectDocsForParser_(folder, includeSubfolders) {
  var visited = new Set(), docs = [];
  function walk_(f) {
    var fid = f.getId();
    if (visited.has(fid)) return;
    visited.add(fid);
    var files = f.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getMimeType() === MimeType.GOOGLE_DOCS) docs.push({ id: file.getId(), name: file.getName() });
    }
    if (!includeSubfolders) return;
    var subs = f.getFolders();
    while (subs.hasNext()) walk_(subs.next());
  }
  walk_(folder);
  return docs;
}

function DU_getDocComments_(docId) {
  var results = [];
  try {
    var pageToken = null;
    do {
      var opts = { maxResults: 100, includeDeleted: false };
      if (pageToken) opts.pageToken = pageToken;
      var resp = Drive.Comments.list(docId, opts);
      var items = resp.items || [];
      for (var i = 0; i < items.length; i++) {
        var c = items[i];
        if (c.deleted) continue;
        var author = (c.author && c.author.displayName) ? c.author.displayName : 'Unknown';
        var content = (c.content || '').trim();
        if (content) results.push({ author: author, content: content });
      }
      pageToken = resp.nextPageToken || null;
    } while (pageToken);
  } catch (e) { /* Drive API not enabled or no permission */ }
  return results;
}

function DU_extractHistoryRows_(table, headerMap) {
  var vCol = headerMap['version'] != null ? headerMap['version'] : null;
  var dCol = headerMap['date'] != null ? headerMap['date'] : null;
  var descCol = headerMap['description'] != null ? headerMap['description'] : null;
  var wCol = headerMap['written by'] != null ? headerMap['written by'] : null;
  var aCol = headerMap['approved by'] != null ? headerMap['approved by'] : null;
  var rows = [];

  for (var r = 1; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    var n = row.getNumCells();
    var version = (vCol != null && vCol < n) ? row.getCell(vCol).getText().trim() : '';
    var date = (dCol != null && dCol < n) ? row.getCell(dCol).getText().trim() : '';
    var description = (descCol != null && descCol < n) ? row.getCell(descCol).getText().trim() : '';
    var writtenBy = (wCol != null && wCol < n) ? row.getCell(wCol).getText().trim() : '';
    var approvedBy = (aCol != null && aCol < n) ? row.getCell(aCol).getText().trim() : '';
    if (!version && !date && !description && !writtenBy && !approvedBy) continue;
    rows.push({ version: version, date: date, description: description, writtenBy: writtenBy, approvedBy: approvedBy });
  }
  return rows;
}
