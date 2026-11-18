/* Recipe Box v3 - snapshot diff.
   Snapshots already store full copies; this shows what actually changed between
   two of them (or between a snapshot and the current recipe) instead of only
   letting you restore blind.
   Loaded after features-search.js. */

function snapFields(snap) {
  var d = (snap && snap.data) || {};
  return {
    title: d.title || '',
    servings: d.servings || '',
    time: d.time || '',
    difficulty: d.difficulty || '',
    ing: (d.ing || []).slice(),
    steps: (d.steps || []).slice(),
    equip: (d.equip || []).slice(),
    nutrition: d.nutrition || '',
    notes: d.notes || '',
    tags: (d.tags || []).slice()
  };
}

function currentFields(r) {
  return {
    title: r.title || '',
    servings: r.servings || '',
    time: r.time || '',
    difficulty: r.difficulty || '',
    ing: (r.ing || []).slice(),
    steps: (r.steps || []).slice(),
    equip: (r.equip || []).slice(),
    nutrition: r.nutrition || '',
    notes: r.notes || '',
    tags: (r.tags || []).slice()
  };
}

var SNAP_LABELS = {
  title: 'Title', servings: 'Servings', time: 'Time', difficulty: 'Difficulty',
  ing: 'Ingredients', steps: 'Method', equip: 'Equipment',
  nutrition: 'Nutrition', notes: 'Notes', tags: 'Tags'
};

function snapText(v) {
  if (Array.isArray(v)) return v.join('\n');
  return String(v == null ? '' : v);
}

/* Word/line level diff for a single field. Returns rows of {kind, text}. */
function snapDiffLines(before, after) {
  var a = snapText(before).split('\n').filter(function (x, i, arr) {
    return x.trim() !== '' || arr.length === 1;
  });
  var b = snapText(after).split('\n').filter(function (x, i, arr) {
    return x.trim() !== '' || arr.length === 1;
  });

  // LCS on trimmed lines so reordering/rewording is visible.
  var n = a.length, m = b.length;
  var dp = [];
  for (var i = 0; i <= n; i++) { dp[i] = []; for (var j = 0; j <= m; j++) dp[i][j] = 0; }
  for (var i2 = n - 1; i2 >= 0; i2--) {
    for (var j2 = m - 1; j2 >= 0; j2--) {
      dp[i2][j2] = a[i2].trim() === b[j2].trim()
        ? dp[i2 + 1][j2 + 1] + 1
        : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }

  var rows = [];
  var x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x].trim() === b[y].trim()) {
      rows.push({ kind: 'same', text: b[y] });
      x++; y++;
    } else if (dp[x + 1][y] >= dp[x][y + 1]) {
      rows.push({ kind: 'del', text: a[x] });
      x++;
    } else {
      rows.push({ kind: 'add', text: b[y] });
      y++;
    }
  }
  while (x < n) { rows.push({ kind: 'del', text: a[x] }); x++; }
  while (y < m) { rows.push({ kind: 'add', text: b[y] }); y++; }

  return rows.filter(function (r) { return r.text.trim() !== ''; });
}

function snapHasChanges(before, after) {
  var keys = Object.keys(SNAP_LABELS);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (snapText(before[k]) !== snapText(after[k])) return true;
  }
  return false;
}

function snapDiffHtml(before, after, beforeLabel, afterLabel) {
  var keys = Object.keys(SNAP_LABELS);
  var html = '<table class="diff-table"><thead><tr>' +
    '<th class="diff-lbl">Field</th><th>' + esc(beforeLabel) + '</th><th>' + esc(afterLabel) + '</th>' +
    '</tr></thead><tbody>';
  var changedAny = false;

  keys.forEach(function (k) {
    var b = snapText(before[k]);
    var a = snapText(after[k]);
    var same = b === a;
    if (!same) changedAny = true;

    var cell = same
      ? '<td class="diff-same">' + esc(b || '(empty)').replace(/\n/g, '<br>') + '</td>'
      : '<td>' + snapDiffRowsHtml(snapDiffLines(b, a)) + '</td>';

    var leftCell = same
      ? '<td class="diff-same">' + esc(b || '(empty)').replace(/\n/g, '<br>') + '</td>'
      : '<td>' + snapDiffRowsHtml(snapDiffLines(b, a).filter(function (r) { return r.kind !== 'add'; })) + '</td>';

    var rightCell = same
      ? '<td class="diff-same">' + esc(b || '(empty)').replace(/\n/g, '<br>') + '</td>'
      : '<td>' + snapDiffRowsHtml(snapDiffLines(b, a).filter(function (r) { return r.kind !== 'del'; })) + '</td>';

    html += '<tr class="' + (same ? 'diff-row-same' : 'diff-row-chg') + '">' +
      '<th class="diff-lbl">' + esc(SNAP_LABELS[k]) + '</th>' + leftCell + rightCell + '</tr>';
  });

  html += '</tbody></table>';
  return { html: html, changed: changedAny };
}

function snapDiffRowsHtml(rows) {
  if (!rows.length) return '<span class="dim">(empty)</span>';
  return rows.map(function (r) {
    var cls = r.kind === 'add' ? 'diff-add' : (r.kind === 'del' ? 'diff-del' : 'diff-same');
    var sign = r.kind === 'add' ? '+ ' : (r.kind === 'del' ? '\u2212 ' : '');
    return '<div class="diff-line ' + cls + '">' + sign + esc(r.text) + '</div>';
  }).join('');
}

function snapLabel(snap, idx, total) {
  if (!snap) return 'Current';
  var when = snap.when ? new Date(snap.when).toLocaleString() : '';
  return '#' + (idx + 1) + (when ? (' \u00b7 ' + when) : '') + (idx === total - 1 ? ' (newest)' : '');
}

function openSnapshotDiff(r) {
  var snaps = (r.snapshots || []);
  if (!snaps.length) { toast('No snapshots to compare'); return; }

  var dlg = document.createElement('dialog');
  dlg.id = 'dSnapDiff';
  dlg.className = 'snapdiff-dialog';

  var options = '<option value="__current__">Current recipe</option>' +
    snaps.map(function (s, i) {
      return '<option value="' + i + '">' + esc(snapLabel(s, i, snaps.length)) + '</option>';
    }).join('');

  var pickRow = function (id, selected) {
    return '<div class="sd-pick"><label for="' + id + '">Compare</label>' +
      '<select id="' + id + '">' + options + '</select></div>';
  };

  dlg.innerHTML =
    '<h2 style="margin-top:0">Snapshot changes</h2>' +
    '<p class="small">See exactly what changed between two saved versions, or between a version and the current recipe.</p>' +
    '<div class="sd-controls">' +
    pickRow('sdFrom', '__current__') +
    '<span class="sd-arrow">\u2192</span>' +
    pickRow('sdTo', snaps.length > 1 ? String(snaps.length - 2) : '0') +
    '</div>' +
    '<div id="sdBody" class="sd-body"></div>' +
    '<div class="row" style="justify-content:flex-start"><button id="sdClose">Close</button></div>';

  document.body.appendChild(dlg);

  function sideValue(v) {
    if (v === '__current__') return { label: 'Current recipe', fields: currentFields(r), snap: null };
    var idx = parseInt(v, 10);
    return { label: snapLabel(snaps[idx], idx, snaps.length), fields: snapFields(snaps[idx]), snap: snaps[idx] };
  }

  function render() {
    var from = sideValue(dlg.querySelector('#sdFrom').value);
    var to = sideValue(dlg.querySelector('#sdTo').value);
    var body = document.getElementById('sdBody');

    if (!snapHasChanges(from.fields, to.fields)) {
      body.innerHTML = '<div class="status ok" style="display:block">No differences between these two.</div>';
      return;
    }
    var res = snapDiffHtml(from.fields, to.fields, from.label, to.label);
    var summary = '';
    var nChg = (res.html.match(/diff-row-chg/g) || []).length;
    summary = '<div class="small" style="margin-bottom:8px">' + nChg + ' field(s) changed</div>';
    body.innerHTML = summary + res.html;
  }

  var a = dlg.querySelector('#sdFrom');
  var b = dlg.querySelector('#sdTo');
  if (a) a.onchange = render;
  if (b) b.onchange = render;

  var closeBtn = dlg.querySelector('#sdClose');
  if (closeBtn) closeBtn.onclick = function () { dlg.close(); };

  function done() { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); }
  dlg.addEventListener('close', done);
  dlg.addEventListener('cancel', function (e) { e.preventDefault(); dlg.close(); });

  // Default the "from" to the oldest snapshot when there is more than one, so
  // the first thing shown is a meaningful change rather than nothing.
  if (snaps.length > 1 && a) { a.value = '0'; }

  render();
  try { dlg.showModal(); } catch (e) { done(); }
}

/* Add a "Diff" button to each snapshot row. */
function snapEnhance(r) {
  var sp = document.getElementById('snapPanel');
  if (!sp || sp.querySelector('[data-snapdiff]')) return;
  // app.js renders rows as data-snap-row (with a hyphen).
  sp.querySelectorAll('[data-snap-row]').forEach(function (row) {
    var idx = row.getAttribute('data-snap-row');
    var b = document.createElement('button');
    b.textContent = 'Diff';
    b.setAttribute('data-snapdiff', idx);
    b.setAttribute('aria-label', 'Compare snapshot ' + (parseInt(idx, 10) + 1));
    row.appendChild(b);
  });

  if (sp.onclick) {
    var prev = sp.onclick;
    sp.onclick = function (e) {
      var d = e.target.closest('button[data-snapdiff]');
      if (d) { openSnapshotDiff(r); return; }
      if (prev) return prev.call(this, e);
    };
  }
}

var _snapDiffBaseView = openView;
openView = function (id) {
  var out = _snapDiffBaseView(id);
  var run = function () {
    try {
      var r = (state.recipes || []).find(function (x) { return x.id === id; });
      if (r) snapEnhance(r);
    } catch (e) {}
  };
  if (out && typeof out.then === 'function') return out.then(run);
  run();
  return out;
};