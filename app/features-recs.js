/* Recipe Box v3 - recommendations layer.
   Scores recipes against what is actually in the pantry, plus dietary tags,
   servings and recency, and renders a "Recommended for you" panel.
   Loaded after features-camera.js. */

var REC_DEFAULT_LIMIT = 5;
var REC_ALLERGEN_WORDS = /(peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|shellfish|shrimp|prawn|crab|lobster|egg|soy|wheat|flour|sesame|milk|butter|cream|cheese)/i;

function recPantrySet() {
  var set = {};
  (state.pantry || []).forEach(function (p) {
    if (!p || !p.have) return;
    var k = pantryKey(p.name);
    if (k) set[k] = true;
  });
  return set;
}

/* How many of a recipe's ingredients the pantry already covers. */
function recPantryHits(r, pantrySet) {
  var ing = (r && r.ing) || [];
  var hits = 0;
  var checked = 0;
  ing.forEach(function (raw) {
    if (isIngHeader(raw)) return;
    var main = splitIngExtra(raw).main;
    var k = pantryKey(main);
    if (!k) return;
    checked++;
    if (pantrySet[k]) { hits++; return; }
    // Tolerate "2 cups all-purpose flour" vs "flour" style differences.
    var words = k.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (pantrySet[words[i]] || pantrySet[words.slice(0, i + 1).join(' ')] || pantrySet[words.slice(i).join(' ')]) { hits++; return; }
    }
  });
  return { hits: hits, total: checked };
}

function recAllergens(r) {
  var found = {};
  ((r && r.ing) || []).forEach(function (raw) {
    var main = splitIngExtra(raw).main;
    if (REC_ALLERGEN_WORDS.test(main)) {
      var m = main.match(REC_ALLERGEN_WORDS);
      if (m) found[m[1].toLowerCase()] = true;
    }
  });
  return Object.keys(found);
}

/* Higher score = better match for this kitchen right now. */
function recommendationScore(r) {
  var pantrySet = recPantrySet();
  var hits = recPantryHits(r, pantrySet);
  var score = 0;
  var parts = [];

  // Pantry coverage is the dominant signal.
  if (hits.total > 0) {
    var cover = hits.hits / hits.total;
    score += cover * 60;
    parts.push({ label: hits.hits + '/' + hits.total + ' on hand', weight: cover * 60 });
  }

  // A recipe with explicit dietary tags that the user filters on is a better fit.
  var dt = (typeof dietaryTags === 'function') ? dietaryTags(r) : [];
  if (dt.length) {
    score += 12;
    parts.push({ label: dt.join(', '), weight: 12 });
  }

  // Prefer recipes that can be made with few shopping trips.
  var missing = Math.max(0, hits.total - hits.hits);
  if (missing === 0 && hits.total > 0) score += 18;
  else if (missing <= 2) score += 8;

  // A rating from the user is a strong personal signal.
  if (r.rating) {
    score += (Number(r.rating) || 0) * 4;
    parts.push({ label: r.rating + '/5 rating', weight: (Number(r.rating) || 0) * 4 });
  }
  if (r.fav) score += 10;

  // Recently cooked recipes are often wanted again; stale ones slightly less.
  if (r.lastCooked) {
    var days = (Date.now() - r.lastCooked) / 86400000;
    if (days < 21) { score += 6; parts.push({ label: 'cooked recently', weight: 6 }); }
  }

  // Penalise very long ingredient lists a little (more effort/weeknight cost).
  if (hits.total > 14) score -= Math.min(10, (hits.total - 14) * 1.5);

  return {
    score: Math.max(0, Math.round(score)),
    pantryHits: hits.hits,
    pantryTotal: hits.total,
    coverage: hits.total ? Math.round((hits.hits / hits.total) * 100) : 0,
    missing: missing,
    dietary: dt,
    allergens: recAllergens(r),
    reasons: parts
  };
}

function getRecommendedRecipes(limit) {
  var pantrySet = recPantrySet();
  var hasPantry = Object.keys(pantrySet).length > 0;
  var list = (state.recipes || []).filter(function (r) {
    return r && (r.ing || []).length > 0;
  });
  list = list.map(function (r) { return { r: r, rec: recommendationScore(r) }; });
  // Without pantry data, fall back to rating/favourite ordering.
  list.sort(function (a, b) {
    if (hasPantry && b.rec.score !== a.rec.score) return b.rec.score - a.rec.score;
    var bf = (b.r.fav ? 1 : 0) - (a.r.fav ? 1 : 0);
    if (bf) return bf;
    var br = (b.r.rating || 0) - (a.r.rating || 0);
    if (br) return br;
    return (b.r.updated || 0) - (a.r.updated || 0);
  });
  return { items: list.slice(0, limit || REC_DEFAULT_LIMIT), hasPantry: hasPantry };
}

function renderRecommendations() {
  var el = document.getElementById('recRecommendations');
  if (!el) return;
  var out = getRecommendedRecipes(REC_DEFAULT_LIMIT);

  if (!state.recipes.length) {
    el.innerHTML = '<div class="panel small"><strong>Recommended</strong>' +
      '<div class="small">Add recipes and they will be ranked by what is in your pantry.</div></div>';
    return;
  }

  var head = '<div class="panel small"><div class="row spread" style="margin:0 0 6px">' +
    '<strong>Recommended</strong>' +
    '<span class="small">' + (out.hasPantry ? 'by pantry match' : 'top rated') + '</span></div>';

  if (!out.items.length) {
    el.innerHTML = head + '<div class="small">Nothing to recommend yet.</div></div>';
    return;
  }

  var rows = out.items.map(function (x) {
    var r = x.r;
    var rec = x.rec;
    var bits = [];
    if (rec.coverage > 0) bits.push(rec.coverage + '% on hand');
    if (rec.missing === 0 && rec.pantryTotal > 0) bits.push('ready to cook');
    else if (rec.pantryTotal > 0) bits.push(rec.missing + ' to buy');
    if (rec.dietary.length) bits.push(rec.dietary.join(', '));
    if (rec.allergens.length) bits.push('contains ' + rec.allergens.slice(0, 3).join('/'));

    return '<div class="itemrow rec-row" data-recid="' + esc(r.id) + '" role="button" tabindex="0" ' +
      'aria-label="Open ' + esc(r.title) + '">' +
      '<div style="flex:1;min-width:0">' +
      '<strong>' + esc(r.title) + '</strong>' +
      '<div class="small">' + esc(bits.join(' · ') || 'no pantry data yet') + '</div>' +
      '</div>' +
      '<span class="badge rec-score" title="match score">' + rec.score + '</span>' +
      '</div>';
  }).join('');

  el.innerHTML = head + '<div class="rec-list">' + rows + '</div></div>';

  if (!el.onclick) {
    function open(id) { if (typeof openView === 'function') openView(id); }
    el.onclick = function (e) {
      var row = e.target.closest('[data-recid]');
      if (row) open(row.dataset.recid);
    };
    el.onkeydown = function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('[data-recid]');
      if (!row) return;
      e.preventDefault();
      open(row.dataset.recid);
    };
  }
}

/* Keep the panel in sync whenever the library re-renders. */
var _recBaseRender = render;
render = function () {
  var out = _recBaseRender.apply(this, arguments);
  try { renderRecommendations(); } catch (e) {}
  return out;
};

var _recBaseRenderPantry = renderPantry;
renderPantry = function () {
  var out = _recBaseRenderPantry.apply(this, arguments);
  try { renderRecommendations(); } catch (e) {}
  return out;
};

function initRecommendationsUI() {
  renderRecommendations();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRecommendationsUI);
else initRecommendationsUI();