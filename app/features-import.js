/* Recipe Box v3 - import diagnostics.
   The relay chain already tries direct + four public relays. When all of them
   fail the old message was a generic "this site may block automated access",
   which does not tell you what to do next. This records per-relay outcomes and
   explains the most likely cause plus a concrete next step.
   Loaded after features-offline.js. */

var _importDiag = null;

function diagReset() {
  _importDiag = { url: '', attempts: [], startedAt: now() };
  return _importDiag;
}

function diagRecord(name, result, detail) {
  if (!_importDiag) diagReset();
  _importDiag.attempts.push({
    name: name,
    result: result,       // ok | http | empty | blocked | error | timeout
    detail: detail || ''
  });
  return _importDiag;
}

/* Classify the failure modes into advice the user can act on. */
function diagExplain(d) {
  if (!d || !d.attempts.length) return '';
  var names = d.attempts.map(function (a) { return a.name; });
  var kinds = {};
  d.attempts.forEach(function (a) { kinds[a.result] = (kinds[a.result] || 0) + 1; });

  if (kinds.ok) {
    return 'Loaded via ' + names[names.length - 1] + '.';
  }

  var lines = [];
  lines.push('Tried ' + names.join(', ') + '.');
  var triedServer = names.some(function (n) { return /^server/.test(n); });
  var serverMissing = d.attempts.some(function (a) { return /route not available/i.test(a.detail || ''); });
  if (serverMissing) {
    lines.push('This build has no server fetch route, so only public relays were tried.');
    lines.push('Next: update Recipe Box on your box to 1.0.2 or later, which fetches pages from your own network.');
  } else {
    lines.push(triedServer
      ? 'Your Recipe Box server tried it from your own network too, so the block is on the site side.'
      : 'The Recipe Box server route was not reachable (a static copy of the app?), so only public relays were tried.');
  }

  if (kinds.blocked) {
    lines.push('The page answered but looked like a bot-check or error page (Cloudflare / "are you a robot" / captcha).');
    lines.push('Next: open the page, copy the recipe text, then use Import \u2192 paste + "Extract with AI".');
    lines.push('If it is image-based, use Photos / PDF \u2192 Read with AI.');
  } else if (kinds.http && kinds.http >= Math.max(2, d.attempts.length - 1)) {
    lines.push('Every route returned an HTTP error, which usually means the site requires a login or blocks server-side requests.');
    lines.push('Next: paste the recipe text and use "Extract with AI".');
  } else if (kinds.timeout) {
    lines.push('Requests timed out. The site may be slow, or relays are unreachable on this network.');
    lines.push('Next: check your connection, then retry, or paste the text instead.');
  } else if (kinds.empty) {
    lines.push('Responses came back empty or too short to contain a recipe.');
    lines.push('Next: the page may render its content with JavaScript. Paste the text or import a PDF/image.');
  } else if (kinds.error) {
    lines.push('Network errors on every route (DNS, TLS or connectivity).');
    lines.push('Next: confirm you are online and that the address is correct.');
  }

  // If only one relay worked, name it so retries can be quicker.
  if (kinds.ok) lines.unshift('Loaded via ' + names[names.length - 1] + '.');

  return lines.join(' ');
}

function diagHtml() {
  if (!_importDiag || !_importDiag.attempts.length) return '';
  var rows = _importDiag.attempts.map(function (a) {
    var label = { ok: 'ok', http: 'HTTP error', empty: 'empty', blocked: 'blocked', error: 'error', timeout: 'timeout' }[a.result] || a.result;
    return '<div class="itemrow"><span class="small" style="flex:1"><strong>' + esc(a.name) + '</strong>' +
      (a.detail ? (' \u2014 ' + esc(a.detail)) : '') + '</span>' +
      '<span class="badge ' + (a.result === 'ok' ? 'diag-ok' : 'diag-err') + '">' + esc(label) + '</span></div>';
  }).join('');
  return '<details class="diag-details" style="margin-top:8px"><summary class="small">Fetch details (' +
    _importDiag.attempts.length + ' route(s))</summary><div class="listbox">' + rows + '</div>' +
    '<p class="hint">' + esc(diagExplain(_importDiag)) + '</p></details>';
}

/* Hook the import status area so the details appear after a failure. */
function diagAttach() {
  var host = document.getElementById('uHint');
  if (!host || host.querySelector('.diag-details')) return;
  if (!_importDiag || !_importDiag.attempts.length) return;
  var ok = _importDiag.attempts.some(function (a) { return a.result === 'ok'; });
  if (ok) return;   // success does not need a post-mortem
  host.insertAdjacentHTML('afterend', diagHtml());
}

/* Wrap getPage so every relay outcome is captured. This does not change fetch
   behaviour; it only observes it. */
var _diagBaseGetPage = null;

function installImportDiagnostics() {
  if (_diagBaseGetPage) return;
  _diagBaseGetPage = getPage;

  getPage = async function (url) {
    diagReset();
    _importDiag.url = url;
    // Re-run the original chain, recording each relay's outcome by watching the
    // thrown error message, which already names the failing route.
    try {
      var res = await _diagBaseGetPage(url);
      // The base error text is not exposed on success, so infer the winner from
      // the returned label.
      diagRecord(res.via || 'relay', 'ok', '');
      diagAttach();
      return res;
    } catch (e) {
      var msg = String(e.message || e);
      // Base message looks like: "Could not load page. Relays: direct: HTTP 403; jina: blocked. ..."
      var m = msg.match(/Relays:\s*(.+?)\.\s*(?:This site|$)/s);
      if (m) {
        m[1].split(';').forEach(function (chunk) {
          var c = chunk.trim();
          var ci = c.indexOf(':');
          if (ci < 0) return;
          var name = c.slice(0, ci).trim();
          var detail = c.slice(ci + 1).trim();
          var result = 'error';
          if (/timed out/i.test(detail)) result = 'timeout';
          else if (/blocked/i.test(detail)) result = 'blocked';
          else if (/empty|short/i.test(detail)) result = 'empty';
          else if (/HTTP/i.test(detail)) { result = 'http'; }
          diagRecord(name, result, detail);
        });
      } else {
        // No structured list (e.g. the URL itself was rejected).
        diagRecord('request', /timed out/i.test(msg) ? 'timeout' : 'error', msg.slice(0, 120));
      }
      diagAttach();
      throw e;
    }
  };
}

/* Inline status styling for the diagnostics list. */
function installDiagStyles() {
  if (document.getElementById('diagStyles')) return;
  var st = document.createElement('style');
  st.id = 'diagStyles';
  st.textContent =
    '.diag-ok{background:var(--ok);color:#fff}' +
    '.diag-err{background:var(--warn);color:#fff}' +
    '.diag-details{border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin-top:6px;background:var(--bg)}' +
    '.diag-details summary{cursor:pointer;font-weight:600}' +
    '.net-badge{cursor:pointer}' +
    '.net-offline{background:var(--warn);color:#fff}' +
    '.net-pending{background:var(--accent);color:var(--accent-ink)}';
  document.head.appendChild(st);
}

function initImportDiagUI() {
  installDiagStyles();
  installImportDiagnostics();
  // The hint element is rebuilt by the import dialog, so clear stale details
  // whenever it is opened.
  var btn = document.getElementById('btnImport');
  if (btn) {
    var prev = btn.onclick;
    btn.onclick = function (e) {
      if (prev) prev.call(this, e);
      setTimeout(function () {
        var d = document.querySelector('#uHint + .diag-details');
        if (d) d.remove();
      }, 0);
    };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initImportDiagUI);
else initImportDiagUI();