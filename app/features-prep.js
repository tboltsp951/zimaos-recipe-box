/* Recipe Box v3 - meal-prep grouping.
   Looks at a date range of planned meals and groups them by what can be batched:
   shared base ingredients first, then shared cookware/appliance, then a simple
   "cook once, eat twice" pass for repeated recipes.
   Loaded after features-review.js. */

function mealPrepRange(from, to) {
  var entries = (state.calendar || []).filter(function (c) {
    return (!from || c.date >= from) && (!to || c.date <= to);
  });
  return entries;
}

/* Expand a plan into per-recipe demand, scaled by the entry's servings. */
function mealPrepDemand(entries) {
  var out = [];
  (entries || []).forEach(function (c) {
    var r = (state.recipes || []).find(function (x) { return x.id === c.recipeId; });
    if (!r) return;
    var factor = entryFactor(c, r);
    out.push({ entry: c, recipe: r, factor: factor, date: c.date, meal: c.meal });
  });
  return out;
}

/* Count how often each ingredient appears across the demand list. */
function mealPrepSharedIngredients(demand) {
  var map = {};
  demand.forEach(function (d) {
    var seen = {};
    (d.recipe.ing || []).forEach(function (line) {
      if (isIngHeader(line)) return;
      var main = splitIngExtra(line).main;
      var k = normItemKey(parseQtyText(main).name || main);
      if (!k || seen[k]) return;
      seen[k] = true;
      if (!map[k]) map[k] = { key: k, count: 0, label: main };
      map[k].count++;
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .filter(function (x) { return x.count > 1; })
    .sort(function (a, b) { return b.count - a.count; });
}

/* Group repeated recipes: same recipe planned more than once in the range. */
function mealPrepRepeats(demand) {
  var byId = {};
  demand.forEach(function (d) {
    if (!byId[d.recipe.id]) byId[d.recipe.id] = { recipe: d.recipe, dates: [] };
    byId[d.recipe.id].dates.push(d.date);
  });
  return Object.keys(byId).map(function (k) { return byId[k]; })
    .filter(function (x) { return x.dates.length > 1; })
    .sort(function (a, b) { return b.dates.length - a.dates.length; });
}

/* Simple appliance inference from equipment + method text. */
var APPLIANCE_HINTS = [
  { name: 'Oven', re: /bake|roast|oven|preheat|350|375|400|425/i },
  { name: 'Stovetop', re: /simmer|boil|saute|sauté|fry|sear|pan|pot|skillet/i },
  { name: 'Slow cooker', re: /slow cook|crock|low for \d+ hour/i },
  { name: 'Grill', re: /grill|griddle|bbq|char/i },
  { name: 'Blender', re: /blend|puree|purée|food processor/i },
  { name: 'Mixer', re: /mixer|whisk|beat|cream together/i }
];

function mealPrepAppliances(demand) {
  var map = {};
  demand.forEach(function (d) {
    var text = ((d.recipe.equip || []).join(' ') + ' ' + (d.recipe.steps || []).join(' '));
    APPLIANCE_HINTS.forEach(function (a) {
      if (a.re.test(text)) {
        if (!map[a.name]) map[a.name] = { name: a.name, count: 0, titles: [] };
        map[a.name].count++;
        if (map[a.name].titles.indexOf(d.recipe.title) < 0) map[a.name].titles.push(d.recipe.title);
      }
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.count - a.count; });
}

function mealPrepSummary(from, to) {
  var entries = mealPrepRange(from, to);
  if (!entries.length) return null;
  var demand = mealPrepDemand(entries);
  if (!demand.length) return null;
  return {
    entries: entries,
    demand: demand,
    shared: mealPrepSharedIngredients(demand),
    repeats: mealPrepRepeats(demand),
    appliances: mealPrepAppliances(demand)
  };
}

function openMealPrep() {
  var cal = document.getElementById('dCalendar');
  var fromEl = document.getElementById('calFrom');
  var toEl = document.getElementById('calTo');
  // The calendar pre-fills these with today, which would silently reduce meal
  // prep to a single day. Only honour the inputs when they form a real range;
  // otherwise use the week currently on screen.
  var weekStart = mondayISO(state.calWeekStart || new Date().toISOString().slice(0, 10));
  var from = (fromEl && fromEl.value) || '';
  var to = (toEl && toEl.value) || '';
  if (!from || !to || from >= to) { from = weekStart; to = addDaysISO(weekStart, 6); }

  var s = mealPrepSummary(from, to);
  if (!s) { toast('No planned meals in that range'); return; }

  var dlg = document.createElement('dialog');
  dlg.id = 'dMealPrep';
  dlg.className = 'prep-dialog';

  var html = '<h2 style="margin-top:0">Meal prep plan</h2>' +
    '<p class="small">' + esc(shortDate(from)) + ' \u2013 ' + esc(shortDate(to)) + ' \u00b7 ' +
    s.demand.length + ' meal(s)</p>';

  if (s.repeats.length) {
    html += '<div class="prep-sec"><h3>Cook once, eat more than once</h3>' +
      s.repeats.map(function (x) {
        return '<div class="prep-item"><strong>' + esc(x.recipe.title) + '</strong>' +
          '<div class="small">' + x.dates.length + ' servings planned: ' +
          esc(x.dates.map(shortDate).join(', ')) +
          (parseServings(x.recipe.servings) > 0
            ? (' \u00b7 base ' + esc(x.recipe.servings))
            : '') + '</div></div>';
      }).join('') + '</div>';
  }

  if (s.shared.length) {
    html += '<div class="prep-sec"><h3>Buy / prep once, use across meals</h3>' +
      '<div class="prep-chips">' + s.shared.slice(0, 14).map(function (x) {
        return '<span class="pill">' + esc(x.label) + ' \u00d7' + x.count + '</span>';
      }).join('') + '</div></div>';
  }

  if (s.appliances.length) {
    html += '<div class="prep-sec"><h3>Group by appliance</h3>' +
      s.appliances.map(function (a) {
        return '<div class="prep-item"><strong>' + esc(a.name) + '</strong> <span class="badge">' + a.count + '</span>' +
          '<div class="small">' + esc(a.titles.slice(0, 4).join(', ')) +
          (a.titles.length > 4 ? (' +' + (a.titles.length - 4) + ' more') : '') + '</div></div>';
      }).join('') + '</div>';
  }

  html += '<div class="row" style="justify-content:flex-start;flex-wrap:wrap">' +
    '<button class="primary" id="prepShop">Add all ingredients to shopping</button>' +
    '<button id="prepClose">Close</button></div>';

  dlg.innerHTML = html;
  document.body.appendChild(dlg);

  var shopBtn = dlg.querySelector('#prepShop');
  if (shopBtn) {
    shopBtn.onclick = function () {
      buildShopFromCalendar(from, to);
      dlg.close();
      openShop();
    };
  }
  var closeBtn = dlg.querySelector('#prepClose');
  if (closeBtn) closeBtn.onclick = function () { dlg.close(); };

  function done() { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); }
  dlg.addEventListener('close', done);
  dlg.addEventListener('cancel', function (e) { e.preventDefault(); dlg.close(); });

  try { dlg.showModal(); } catch (e) { done(); }
}

function initMealPrepUI() {
  var b = document.getElementById('calPrep');
  if (b) b.onclick = openMealPrep;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMealPrepUI);
else initMealPrepUI();