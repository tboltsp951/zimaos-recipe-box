/* Recipe Box v3 - import review with the source photo beside the extraction.
   After a camera scan the plain edit form makes it hard to check a transcription
   against the card. This dialog keeps each captured photo next to the fields so
   `[?]` markers can be fixed while looking at the original.
   Loaded after features-cards.js. */

function reviewFlagCount(text) {
  var m = String(text || '').match(/\[\?\]/g);
  return m ? m.length : 0;
}

/* Count uncertain readings across a recipe's ingredients and steps. */
function reviewFlags(r) {
  var n = 0;
  (r.ing || []).forEach(function (s) { n += reviewFlagCount(splitIngExtra(s).main); });
  (r.steps || []).forEach(function (s) { n += reviewFlagCount(s); });
  if (r.notes) n += reviewFlagCount(r.notes);
  return n;
}

function reviewHighlight(text) {
  // Mark [?] so the user can spot what needs checking, without changing data.
  return esc(text).replace(/\[(\?)\]/g, '<mark class="rev-flag">[$1]</mark>')
    .replace(/\[illegible\]/gi, '<mark class="rev-flag">[illegible]</mark>');
}

/* Strip a [?] marker the user has resolved. */
function reviewClean(text) {
  return String(text == null ? '' : text).replace(/\[\?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function reviewDialogFor(r, photos, onSave) {
  return new Promise(function (resolve) {
    var dlg = document.createElement('dialog');
    dlg.id = 'dReview';
    dlg.className = 'rev-dialog';

    var flagged = reviewFlags(r);
    var photoHtml = (photos && photos.length)
      ? '<div class="rev-photos">' + photos.map(function (p, i) {
          return '<figure class="rev-fig"><img src="' + esc(p.url) + '" alt="Captured page ' + (i + 1) + '">' +
            '<figcaption>Page ' + (i + 1) + '</figcaption></figure>';
        }).join('') + '</div>'
      : '<div class="small dim">No photos were attached to this import.</div>';

    var ingRows = (r.ing || []).map(function (line, i) {
      if (isIngHeader(line)) {
        return '<div class="rev-grp">' + esc(ingHeaderText(line)) + '</div>';
      }
      var x = splitIngExtra(line);
      var flags = reviewFlagCount(x.main);
      return '<div class="rev-row' + (flags ? ' rev-row-flag' : '') + '">' +
        '<label for="ri' + i + '">' + (flags ? ('<span class="badge rev-badge">' + flags + ' unclear</span>') : '') + '</label>' +
        (flags ? ('<div class="rev-hint">' + reviewHighlight(x.main) + '</div>') : '') +
        '<textarea id="ri' + i + '" data-ri="' + i + '" rows="1">' + esc(x.main) + '</textarea>' +
        (x.note ? '<div class="small dim">note: ' + esc(x.note) + '</div>' : '') +
        (x.sub ? '<div class="small dim">sub: ' + esc(x.sub) + '</div>' : '') +
        '</div>';
    }).join('');

    var stepRows = (r.steps || []).map(function (s, i) {
      var flags = reviewFlagCount(s);
      return '<div class="rev-row' + (flags ? ' rev-row-flag' : '') + '">' +
        '<label for="rs' + i + '">Step ' + (i + 1) + (flags ? (' <span class="badge rev-badge">' + flags + ' unclear</span>') : '') + '</label>' +
        (flags ? ('<div class="rev-hint">' + reviewHighlight(s) + '</div>') : '') +
        '<textarea id="rs' + i + '" data-rs="' + i + '" rows="2">' + esc(s) + '</textarea></div>';
    }).join('');

    dlg.innerHTML =
      '<h2 style="margin-top:0">Review import</h2>' +
      '<p class="small">Check the extracted text against the ' + (photos && photos.length ? 'photo(s)' : 'source') +
      '. Anything the AI was unsure about is highlighted and marked <code>[?]</code>.</p>' +
      '<div class="rev-summary">' +
      '<span class="pill">title: ' + esc(r.title || 'Untitled') + '</span>' +
      (r.servings ? '<span class="pill">' + esc(String(r.servings)) + ' servings</span>' : '') +
      '<span class="badge ' + (flagged ? 'rev-badge' : 'rev-ok') + '">' +
      (flagged ? (flagged + ' uncertain reading(s)') : 'nothing flagged') + '</span>' +
      '</div>' +
      '<div class="rev-grid">' +
      '<div class="rev-col rev-src"><h3>Source</h3>' + photoHtml +
      '<div class="rev-note">Rendered for reference only. Edit the text on the right.</div></div>' +
      '<div class="rev-col rev-fields">' +
      '<label for="revTitle">Title</label><input id="revTitle" value="' + esc(r.title || '') + '">' +
      '<h3>Ingredients</h3>' + (ingRows || '<div class="small dim">None</div>') +
      '<h3>Method</h3>' + (stepRows || '<div class="small dim">None</div>') +
      '</div></div>' +
      '<div class="row" style="justify-content:flex-start;flex-wrap:wrap">' +
      '<button class="primary" id="revSave">Save recipe</button>' +
      '<button id="revClean">Clear [?] marks</button>' +
      '<button class="danger" id="revDiscard">Discard</button></div>';

    document.body.appendChild(dlg);

    function collect() {
      var titleEl = dlg.querySelector('#revTitle');
      var out = Object.assign({}, r);
      out.title = reviewClean(titleEl ? titleEl.value : r.title);
      out.ing = (r.ing || []).map(function (line, i) {
        if (isIngHeader(line)) return line;
        var x = splitIngExtra(line);
        var ta = dlg.querySelector('[data-ri="' + i + '"]');
        var main = reviewClean(ta ? ta.value : x.main);
        var s = main;
        if (x.note) s += ' | note: ' + x.note;
        if (x.sub) s += ' | sub: ' + x.sub;
        return s;
      });
      out.steps = (r.steps || []).map(function (s, i) {
        var ta = dlg.querySelector('[data-rs="' + i + '"]');
        return reviewClean(ta ? ta.value : s);
      }).filter(function (s) { return s.length > 0; });
      return out;
    }

    var settled = false;
    /* saveIt: true = keep, false = skip this one, null = stop the batch. */
    function finish(saveIt) {
      if (settled) return;
      settled = true;
      var result = saveIt === null ? null : (saveIt ? collect() : false);
      try { dlg.close(); } catch (e) {}
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      resolve(result);
    }

    var saveBtn = dlg.querySelector('#revSave');
    if (saveBtn) saveBtn.onclick = function () { finish(true); };
    var discardBtn = dlg.querySelector('#revDiscard');
    if (discardBtn) discardBtn.onclick = function () { finish(false); };

    var cleanBtn = dlg.querySelector('#revClean');
    if (cleanBtn) {
      cleanBtn.onclick = function () {
        dlg.querySelectorAll('textarea[data-ri], textarea[data-rs]').forEach(function (ta) {
          ta.value = reviewClean(ta.value);
        });
        var badge = dlg.querySelector('.rev-summary .rev-badge');
        if (badge) { badge.textContent = 'nothing flagged'; badge.className = 'badge rev-ok'; }
        dlg.querySelectorAll('.rev-row-flag').forEach(function (row) { row.classList.remove('rev-row-flag'); });
      };
    }

    dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); });
    dlg.addEventListener('close', function () {
      // finish() already settled the promise; only an external close (e.g. a
      // stray Escape) needs handling here.
      if (settled) return;
      settled = true;
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      resolve(null);
    });

    try { dlg.showModal(); } catch (e) { finish(false); }
  });
}

/* Entry point: review a batch of freshly imported recipes, keeping the photos
   that produced them available for comparison. */
async function reviewImportedWithPhotos(recipes, photos) {
  var queue = (recipes || []).slice();
  var accepted = [];

  while (queue.length) {
    var r = queue.shift();
    if (!r) continue;
    var result = await reviewDialogFor(r, photos, null);
    if (result === null) break;              // dialog closed = stop the batch
    if (result === false) continue;          // discarded this one
    accepted.push(result);
  }

  if (!accepted.length) return 0;

  var added = await addImported(accepted, checked($('fImpCat')), { title: 'Reviewed import' });
  render();
  toast('Saved ' + accepted.length + ' reviewed recipe(s)');
  return accepted.length;
}

function initReviewUI() {
  // Nothing to wire on load; the review flow is driven by the camera and the
  // paste/image import paths.
  void reviewHighlight;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initReviewUI);
else initReviewUI();