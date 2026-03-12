/** TrustOpsFormatter.gs **/

function WD_mapTestRecord_(test) {
  const rawStatus = String(
    test.status ||
    test.remediationStatus ||
    test.state ||
    ''
  ).trim();

  const normalizedStatus = WD_normalizeStatus_(rawStatus);

  const dueString = WD_pickDueDateString_(test);
  const dueDate = dueString ? WD_parseDateSafe_(dueString) : null;

  const name = String(
    test.name ||
    test.title ||
    test.testName ||
    ''
  ).trim();

  const link = WD_pickBestTestUrl_(test);

  return {
    testId: String(test.id || test.testId || '').trim(),
    name: name,
    link: link,
    rawStatus: rawStatus,
    normalizedStatus: normalizedStatus,
    dueDate: dueDate ? dueDate.toISOString() : '',
    dueLabel: dueDate ? WD_formatRelativeDue_(dueDate) : 'No due date',
    shouldFetchEntities: WD_shouldFetchEntities_(rawStatus),
    failingEntities: [],
    failingEntityCount: 0,
    showEntityListInline: false,
    raw: test
  };
}

/**
 * Mirrors your GAsync mapping:
 * OK -> OK
 * Not relevant / deactivated -> Deactivated
 * Needs document / needs attention / needs update -> Outstanding
 * Hold/Observation -> Hold for Observation
 * else -> Outstanding
 */
function WD_normalizeStatus_(rawStatus) {
  const s = String(rawStatus || '').trim().toUpperCase();

  if (s === 'OK') return 'OK';

  if (s === 'NOT RELEVANT' || s === 'DEACTIVATE' || s === 'DEACTIVATED') {
    return 'Deactivated';
  }

  if (
    s === 'NEEDS DOCUMENT' ||
    s === 'NEEDS ATTENTION' ||
    s === 'NEEDS_ATTENTION' ||
    s === 'NEEDS UPDATE' ||
    s === 'NEEDS_UPDATE'
  ) {
    return 'Outstanding';
  }

  if (s.indexOf('HOLD') >= 0 || s.indexOf('OBSERVATION') >= 0) {
    return 'Hold for Observation';
  }

  return 'Outstanding';
}

function WD_shouldFetchEntities_(rawStatus) {
  const s = String(rawStatus || '').trim().toUpperCase();
  return (
    s === 'NEEDS ATTENTION' ||
    s === 'NEEDS_ATTENTION' ||
    s === 'NEEDS UPDATE' ||
    s === 'NEEDS_UPDATE' ||
    s === 'NEEDS DOCUMENT'
  );
}

function WD_pickDueDateString_(test) {
  const remediation = test.remediationStatusInfo || test.remediationStatus || {};

  const candidates = [
    remediation.soonestRemediateByDate,
    remediation.soonestDueByDate,
    test.dueDate,
    test.remediateByDate,
    test.nextDueDate,
    test.due_at
  ];

  for (var i = 0; i < candidates.length; i++) {
    const val = String(candidates[i] || '').trim();
    if (val) return val;
  }

  return '';
}

function WD_pickBestTestUrl_(test) {
  const candidates = [
    test.webUrl,
    test.url,
    test.link,
    test.consoleUrl
  ];

  for (var i = 0; i < candidates.length; i++) {
    const val = String(candidates[i] || '').trim();
    if (val) return val;
  }

  return '';
}

function WD_parseDateSafe_(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function WD_formatRelativeDue_(dueDate) {
  const now = new Date();
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDue = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());

  const diffMs = startDue.getTime() - startNow.getTime();
  const diffDays = Math.round(diffMs / 86400000);

  if (diffDays === 0) return 'due today';
  if (diffDays === 1) return 'due tomorrow';
  if (diffDays > 1) return 'due in ' + diffDays + ' days';
  if (diffDays === -1) return 'OVERDUE - due 1 day ago';
  return 'OVERDUE - due ' + Math.abs(diffDays) + ' days ago';
}

function WD_escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function WD_buildTrustOpsMessage_(ctx) {
  const lines = [];

  lines.push('Hi ' + ctx.clientName + ", Here's an update on our recent progress.");
  if (ctx.projectPlanLink) {
    lines[0] += ' Refer to the project plan to track where we\'re at in the process: ' + ctx.projectPlanLink;
  }
  lines.push('');
  lines.push('Tests we need your help with:');
  lines.push('');

  if (!ctx.tests.length) {
    lines.push('No outstanding tests at the moment.');
    return lines.join('\n');
  }

  ctx.tests.forEach(function(test, idx) {
    const base = (idx + 1) + '. ' + test.name +
      (test.link ? ' (' + test.link + ')' : '') +
      ' (' + test.dueLabel + ')';

    lines.push(base);

    if (test.failingEntityCount > 0) {
      if (test.showEntityListInline) {
        lines.push('   - Failing entities (' + test.failingEntityCount + '): ' + test.failingEntities.join(', '));
      } else {
        lines.push('   - Failing entities: ' + test.failingEntityCount + ' items');
      }
    }

    lines.push('');
  });

  if (ctx.evidenceDropLink) {
    lines.push('Please upload screenshots / documents here: ' + ctx.evidenceDropLink);
  }

  if (ctx.cloudSecIncluded) {
    lines.push('');
    lines.push('Workstreet CloudSec is included in this engagement.');
  }

  return lines.join('\n').trim();
}

function WD_buildTrustOpsHtml_(ctx) {
  const html = [];

  html.push('<div class="trustops-output">');
  html.push('<p>Hi <strong>' + WD_escapeHtml_(ctx.clientName) + '</strong>, Here\'s an update on our recent progress.' +
    (ctx.projectPlanLink
      ? ' Refer to the <a href="' + WD_escapeHtml_(ctx.projectPlanLink) + '" target="_blank">project plan</a> to track where we\'re at in the process.'
      : '') +
    '</p>');

  html.push('<h4>Tests we need your help with:</h4>');

  if (!ctx.tests.length) {
    html.push('<p>No outstanding tests at the moment.</p>');
    html.push('</div>');
    return html.join('');
  }

  html.push('<ol class="output-list">');

  ctx.tests.forEach(function(test) {
    html.push('<li>');
    if (test.link) {
      html.push('<a href="' + WD_escapeHtml_(test.link) + '" target="_blank">' + WD_escapeHtml_(test.name) + '</a>');
    } else {
      html.push('<span>' + WD_escapeHtml_(test.name) + '</span>');
    }

    html.push(' <strong>(' + WD_escapeHtml_(test.dueLabel) + ')</strong>');

    if (test.failingEntityCount > 0) {
      if (test.showEntityListInline) {
        html.push('<ul><li><strong>Failing entities (' + test.failingEntityCount + '):</strong> ' +
          WD_escapeHtml_(test.failingEntities.join(', ')) + '</li></ul>');
      } else {
        html.push('<ul><li><strong>Failing entities:</strong> ' +
          WD_escapeHtml_(String(test.failingEntityCount)) + ' items</li></ul>');
      }
    }

    html.push('</li>');
  });

  html.push('</ol>');

  if (ctx.evidenceDropLink) {
    html.push('<p>Please upload screenshots / documents <a href="' +
      WD_escapeHtml_(ctx.evidenceDropLink) +
      '" target="_blank">here</a>.</p>');
  }

  if (ctx.cloudSecIncluded) {
    html.push('<p><strong>Workstreet CloudSec</strong> is included in this engagement.</p>');
  }

  html.push('</div>');
  return html.join('');
}