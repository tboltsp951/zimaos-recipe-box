/* Dedicated Favorites section.
   Favorites are still stored as the ordinary `fav` flag on each recipe, so
   sync, backup/export and the existing "Favorites only" filter keep working.
   This panel is just a always-visible shortcut to the flagged recipes. */

function favoriteRecipes() {
  return (state.recipes || []).filter(function (r) { return r && r.fav; })
    .sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); });
}

function renderFavorites() {
  var box = document.getElementById('favList');
  if (!box) return;
  var favs = favoriteRecipes();
  var count = document.getElementById('favCount');
  if (count) count.textContent = '(' + favs.length + ')';
  var show = document.getElementById('favShowAll');
  if (show) {
    show.disabled = !favs.length;
    show.textContent = (state.filters && state.filters.fav) ? 'Show all recipes' : 'Show all favorites';
  }
  if (!favs.length) {
    box.innerHTML = '<div class="hint">No favorites yet. Open a recipe and click ☆ Favorite, or tick “Favorite” when editing.</div>';
    return;
  }
  box.innerHTML = favs.map(function (r) {
    return '<button class="chip fav-item" data-favid="' + esc(r.id) + '" title="' + esc(r.title) + '">★ ' + esc(r.title) + '</button>';
  }).join('');
}

function toggleFavoritesOnly() {
  state.filters = state.filters || {};
  var turningOn = !state.filters.fav;
  state.filters.fav = turningOn;
  if (turningOn) {
    // "Show all favorites" really means all of them, regardless of any
    // category/main/search filters left over from the main library.
    state.sel = [];
    state.mains = [];
    var q = document.getElementById('q');
    if (q) q.value = '';
  }
  if (typeof syncFilterInputs === 'function') syncFilterInputs();
  render();
}

(function () {
  var list = document.getElementById('favList');
  if (list) list.onclick = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-favid]') : null;
    if (el) openView(el.getAttribute('data-favid'));
  };
  var show = document.getElementById('favShowAll');
  if (show) show.onclick = toggleFavoritesOnly;
})();

var _favBaseRender = render;
render = function () {
  var out = _favBaseRender.apply(this, arguments);
  try { renderFavorites(); } catch (e) {}
  return out;
};

renderFavorites();
