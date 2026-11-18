/* Recipe Box v3 - pantry shelf tags.
   Groups pantry items by the same aisle guesser the shopping list uses, with
   per-shelf counts, and keeps the existing check/remove behaviour.
   Loaded after features-subs.js. */

var _shelfBaseRenderPantry = renderPantry;

var SHELF_ORDER = ['Produce', 'Dairy & Eggs', 'Meat & Protein', 'Bakery', 'Pantry', 'Frozen', 'Other'];

function shelfOf(p) {
  var a = guessAisle(p && p.name);
  return SHELF_ORDER.indexOf(a) > -1 ? a : 'Other';
}

function shelfGroups(items) {
  var map = {};
  (items || []).forEach(function (p, i) {
    var s = shelfOf(p);
    if (!map[s]) map[s] = [];
    map[s].push({ p: p, i: i });
  });
  return map;
}

renderPantry = function () {
  var el = document.getElementById('pantryList');
  if (!el) return;
  var items = state.pantry || [];

  if (!items.length) {
    el.innerHTML = '<div class="small">No pantry items.</div>';
    return;
  }

  var groups = shelfGroups(items);
  var shelves = Object.keys(groups).sort(function (a, b) {
    var ia = SHELF_ORDER.indexOf(a), ib = SHELF_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  var html = '';
  shelves.forEach(function (s) {
    var rows = groups[s];
    var have = rows.filter(function (x) { return x.p && x.p.have; }).length;
    html += '<div class="shelf">' +
      '<div class="shelf-head"><span class="shelf-name">' + esc(s) + '</span>' +
      '<span class="badge shelf-count">' + have + '/' + rows.length + ' have</span></div>' +
      rows.map(function (x) {
        var p = x.p;
        return '<div class="pantry-item"><label class="ck" style="flex:1"><input type="checkbox" data-ph="' + x.i + '" ' +
          (p.have ? 'checked' : '') + '> ' + esc(p.name) +
          (p.cost ? (' <span class="small">($' + esc(p.cost) + ')</span>') : '') +
          '</label><button data-prm="' + x.i + '" aria-label="Remove ' + esc(p.name) + '">\u00d7</button></div>';
      }).join('') +
      '</div>';
  });

  el.innerHTML = html;

  el.onchange = function (e) {
    var cb = e.target.closest('input[data-ph]');
    if (!cb) return;
    var it = (state.pantry || [])[+cb.dataset.ph];
    if (it) it.have = cb.checked;
    save();
    renderPantry();
  };

  el.onclick = function (e) {
    var b = e.target.closest('button[data-prm]');
    if (!b) return;
    state.pantry.splice(+b.dataset.prm, 1);
    save();
    renderPantry();
  };
};

/* Keep recommendations in step when pantry contents change. */
var _shelfBaseRenderRecs = null;
function initShelfUI() {
  renderPantry();
  try { if (typeof renderRecommendations === 'function') renderRecommendations(); } catch (e) {}
  var addBtn = document.getElementById('pantryAdd');
  if (addBtn) {
    var prev = addBtn.onclick;
    addBtn.onclick = function (e) {
      var out = prev ? prev.call(this, e) : undefined;
      setTimeout(function () { try { renderPantry(); } catch (err) {} }, 0);
      return out;
    };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initShelfUI);
else initShelfUI();