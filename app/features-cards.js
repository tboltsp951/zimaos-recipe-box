/* Recipe Box v3 - recipe card printing.
   One recipe per page in a compact card layout suitable for printing and filing
   into a physical recipe box. Reuses the ingredient/cookbook rendering helpers.
   Loaded after features-shelf.js. */

/* Rough per-unit prices (USD). Deliberately conservative: this is an estimate,
   not a quote. Override by setting a pantry item's cost, which takes priority. */
var CARD_PRICES = {
  '': 0,            // unknown count item - contributes nothing
};

/* Best-effort unit price for one ingredient line, in cents per base unit. */
var UNIT_PRICE_TABLE = {
  // per tsp
  tsp: { salt: 0.02, pepper: 0.04, cumin: 0.08, paprika: 0.07, oregano: 0.06, basil: 0.09, cinnamon: 0.08, 'baking soda': 0.03, 'baking powder': 0.04, vanilla: 0.35, sugar: 0.05 },
  // per cup
  cup: { flour: 12, sugar: 15, 'brown sugar': 18, rice: 20, oats: 13, milk: 25, buttermilk: 30, water: 0.1, broth: 45, stock: 45, 'olive oil': 55, butter: 60, honey: 70, 'peanut butter': 55 },
  // per lb
  lb: { beef: 550, chicken: 380, pork: 450, lamb: 750, turkey: 420, salmon: 900, shrimp: 850, tofu: 240, beans: 180 },
  // per count
  '': { egg: 25, eggs: 25, onion: 60, onions: 60, garlic: 40, clove: 12, cloves: 12, carrot: 25, carrots: 25, lemon: 50, lemons: 50, lime: 30, potato: 30, potatoes: 30, tomato: 45, tomatoes: 45, apple: 60, banana: 25, can: 120, jar: 250 }
};

var ING_PRICE_CACHE = {};

/* Return an estimated price for one ingredient line, or null if unknown. */
function ingredientPriceCents(raw) {
  var x = splitIngExtra(raw);
  var p = parseQtyText(x.main);
  if (p.kind === 'raw' || p.qty == null) return null;
  var name = String(p.name || '').toLowerCase().trim();
  var unit = p.unit || '';
  var qty = p.qty;

  // Pantry cost wins if the user has entered one.
  var pk = pantryKey(name);
  var pantry = (state.pantry || []).find(function (it) {
    return it && it.cost && pantryKey(it.name) === pk;
  });
  if (pantry && pantry.cost) {
    var c = parseFloat(pantry.cost);
    if (isFinite(c) && c > 0) {
      // cost is per item as entered; treat as total for this line
      return Math.round(c * 100);
    }
  }

  var table = UNIT_PRICE_TABLE[unit] || UNIT_PRICE_TABLE[''];
  if (!table) return null;

  // Try full name, then the last word, then the first word.
  var keys = [name];
  var words = name.split(' ');
  if (words.length > 1) {
    keys.push(words[words.length - 1]);
    keys.push(words[0]);
  }
  var rate = null;
  for (var i = 0; i < keys.length && rate == null; i++) {
    var k = keys[i];
    // singular/plural tolerance
    if (table[k] != null) rate = table[k];
    else if (table[singularWord(k)] != null) rate = table[singularWord(k)];
    else if (table[pluralWord(k)] != null) rate = table[pluralWord(k)];
  }
  if (rate == null) return null;
  if (unit === 'tsp') return Math.round(rate * qty);
  if (unit === 'cup' || unit === 'lb') return Math.round(rate * qty);
  return Math.round(rate * qty);
}

function recipeCostCents(r) {
  var total = 0, priced = 0, lines = 0;
  (r.ing || []).forEach(function (raw) {
    if (isIngHeader(raw)) return;
    lines++;
    var c = ingredientPriceCents(raw);
    if (c != null) { total += c; priced++; }
  });
  return { total: total, priced: priced, lines: lines };
}

function recipeCostPerServing(r) {
  var c = recipeCostCents(r);
  var serv = parseServings(r.servings);
  var per = (serv > 0 && c.priced > 0) ? Math.round(c.total / serv) : null;
  return { cents: c.total, perServing: per, priced: c.priced, lines: c.lines };
}

function money(cents) {
  if (cents == null) return '';
  return '$' + (cents / 100).toFixed(2);
}

/* ===== Card printing ===== */
function printRecipeCards(ids) {
  var list = (ids && ids.length)
    ? ids.map(function (id) { return (state.recipes || []).find(function (r) { return r.id === id; }); }).filter(Boolean)
    : state.recipes.slice();

  if (!list.length) { toast('No recipes to print'); return; }

  var cards = list.map(function (r) {
    var cost = recipeCostPerServing(r);
    var factor = 1;
    var body = '';

    body += '<div class="card-title">' + esc(r.title) + (r.fav ? ' <span class="fav">\u2605</span>' : '') + '</div>';
    var meta = [r.servings ? (r.servings + ' servings') : '', r.time || '', r.difficulty || ''].filter(Boolean);
    if (meta.length || r.rating) {
      body += '<div class="card-meta">' + esc(meta.join(' \u00b7 ')) +
        (r.rating ? (' \u00b7 ' + r.rating + '/5') : '') + '</div>';
    }
    if (cost.perServing != null) {
      body += '<div class="card-cost">Est. ' + money(cost.perServing) + ' per serving <span class="dim">(' +
        money(cost.cents) + ' total' +
        (cost.priced < cost.lines ? (', ' + (cost.lines - cost.priced) + ' unpriced') : '') + ')</span></div>';
    }

    // Ingredients, grouped
    body += '<div class="card-sec"><h4>Ingredients</h4>';
    var groups = ingGroups(r);
    if (!groups.length) {
      body += '<ul><li><em>None</em></li></ul>';
    } else {
      groups.forEach(function (g) {
        if (g.title) body += '<div class="card-grp">' + esc(g.title) + '</div>';
        body += '<ul>' + g.items.map(function (item) {
          var x = splitIngExtra(item.text);
          return '<li>' + esc(fmtIng(x.main, factor)) +
            (x.sub ? ' <span class="card-sub">[sub: ' + esc(x.sub) + ']</span>' : '') +
            (x.note ? ' <span class="dim">(' + esc(x.note) + ')</span>' : '') + '</li>';
        }).join('') + '</ul>';
      });
    }
    body += '</div>';

    // Steps
    body += '<div class="card-sec"><h4>Method</h4><ol>' +
      ((r.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') || '<li><em>None</em></li>') +
      '</ol></div>';

    if (r.equip && r.equip.length) {
      body += '<div class="card-sec card-small"><strong>Equipment:</strong> ' + esc(r.equip.join(', ')) + '</div>';
    }
    if (r.nutrition) {
      body += '<div class="card-sec card-small"><strong>Nutrition (est.):</strong> ' + esc(r.nutrition) + '</div>';
    }
    if (r.notes) {
      body += '<div class="card-sec card-small"><strong>Notes:</strong> ' + esc(r.notes).replace(/\n/g, '<br>') + '</div>';
    }
    if (r.src) {
      body += '<div class="card-src">' + esc(r.src) + '</div>';
    }
    body += '<div class="card-foot">Recipe Box \u00b7 ' + esc(new Date().toLocaleDateString()) + '</div>';

    return '<div class="rcard">' + body + '</div>';
  }).join('');

  var html = '<!doctype html><meta charset="utf-8"><title>Recipe cards</title><style>' +
    '@page{size:auto;margin:12mm}' +
    'body{font:12.5px/1.4 Georgia,serif;color:#111;margin:0;padding:0}' +
    '.rcard{border:1px solid #999;border-radius:8px;padding:12px 14px;margin:0 0 14px;page-break-inside:avoid}' +
    '.card-title{font:700 1.05rem system-ui,sans-serif;margin:0 0 2px}' +
    '.card-meta,.card-cost,.card-src{font-size:.8rem;color:#555}' +
    '.card-cost{color:#0a5c4a;font-weight:600}' +
    '.dim{color:#777;font-weight:400}' +
    '.fav{color:#c9971c}' +
    '.card-sec{margin-top:8px}' +
    '.card-sec h4{font:600 .7rem system-ui,sans-serif;text-transform:uppercase;letter-spacing:.07em;margin:0 0 3px;border-bottom:1px solid #ddd;padding-bottom:2px}' +
    '.card-grp{font-weight:600;font-size:.82rem;margin:5px 0 1px;color:#333}' +
    '.card-sec ul,.card-sec ol{margin:2px 0;padding-left:18px}' +
    '.card-sec li{margin:1px 0}' +
    '.card-small{font-size:.82rem;color:#333}' +
    '.card-sub{color:#8a5a00}' +
    '.card-foot{font-size:.68rem;color:#999;margin-top:8px;border-top:1px dotted #ccc;padding-top:3px}' +
    '.noprint{position:fixed;right:16px;top:16px;padding:8px 14px;font:14px system-ui;border:1px solid #999;border-radius:8px;background:#fff;cursor:pointer}' +
    '@media print{.noprint{display:none}body{margin:0}}' +
    '</style><button class="noprint" onclick="window.print()">Print / Save as PDF</button>' +
    '<p style="font:12px system-ui;color:#555;margin:0 0 12px">' + list.length +
    ' recipe card(s) \u00b7 costs are estimates, not prices</p>' + cards;

  var w = window.open('', '_blank');
  if (!w) {
    var blob = new Blob([html], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'recipe-cards.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Pop-up blocked; downloaded recipe cards HTML instead');
    return;
  }
  w.document.write(html);
  w.document.close();
  setTimeout(function () { try { w.focus(); } catch (e) {} }, 100);
}

/* ===== Cross-serving duplicate detection =====
   Two entries for the same dish at different yields ("Chili" vs "Chili (x2)")
   compare poorly on raw ingredient text because every quantity differs.
   Normalise quantities away before comparing, then require the title to match
   closely as well, to avoid merging genuinely different recipes. */
function normQtyForDup(ingLine) {
  var x = splitIngExtra(ingLine);
  var p = parseQtyText(x.main);
  var name;
  if (p.kind === 'raw') name = normItemKey(x.main);
  else {
    name = normItemKey(p.name || x.main);
    // Count nouns collapse: "2 onions" and "1 onion" are the same ingredient.
    name = name.split(' ').map(function (w, i, a) {
      return i === a.length - 1 ? singularWord(w) : w;
    }).join(' ');
  }
  return name;
}

function dupIngredientSet(r) {
  var set = {};
  ((r && r.ing) || []).forEach(function (line) {
    if (isIngHeader(line)) return;
    var k = normQtyForDup(line);
    if (k) set[k] = true;
  });
  return set;
}

function dupIngredientScore(a, b) {
  var A = dupIngredientSet(a), B = dupIngredientSet(b);
  var ka = Object.keys(A), kb = Object.keys(B);
  if (!ka.length || !kb.length) return 0;
  var shared = ka.filter(function (k) { return B[k]; }).length;
  if (!shared) return 0;
  // Jaccard: rewards matching both directions, ignores relative amounts.
  return shared / (ka.length + kb.length - shared);
}

function servingsOf(r) {
  var n = parseServings(r && r.servings);
  return n > 0 ? n : 0;
}

/* Strip yield markers so "Chili" and "Chili (x2)" compare as the same title. */
function normDupTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(\s*x\s*\d+\s*\)/g, ' ')
    .replace(/\(\s*(double|doubled|half|halved|triple|party)\s*\)/g, ' ')
    .replace(/\bx\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* Returns pairs that look like the same recipe at different yields. */
function findCrossServingDuplicates() {
  var out = [];
  var list = state.recipes || [];
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      var a = list[i], b = list[j];
      var ts = sim(normDupTitle(a.title), normDupTitle(b.title));
      if (ts < 0.55) continue;
      var ing = dupIngredientScore(a, b);
      if (ing < 0.6) continue;
      var sa = servingsOf(a), sb = servingsOf(b);
      if (sa > 0 && sb > 0 && Math.abs(sa - sb) < 0.01) continue;   // same yield = ordinary duplicate
      out.push({
        a: a, b: b,
        titleScore: ts,
        ingScore: ing,
        sameYield: sa > 0 && sb > 0 && Math.abs(sa - sb) < 0.01,
        ratio: (sa > 0 && sb > 0) ? (Math.max(sa, sb) / Math.min(sa, sb)) : 0
      });
    }
  }
  out.sort(function (x, y) { return (y.titleScore + y.ingScore) - (x.titleScore + x.ingScore); });
  return out;
}

function offerCrossServingMerge() {
  var pairs = findCrossServingDuplicates();
  if (!pairs.length) return;

  var lines = pairs.slice(0, 8).map(function (p) {
    var sa = p.a.servings || '?', sb = p.b.servings || '?';
    return '\u2022 ' + p.a.title + ' (' + sa + ') \u2194 ' + p.b.title + ' (' + sb + ')';
  }).join('\n');

  var msg = 'Possible same recipe at different servings:\n\n' + lines +
    '\n\nOpen either recipe and use "Set as base" to align yields, or delete the extra.';

  // Non-blocking: log it, and surface it from the duplicates dialog.
  state.crossServingDupes = pairs.map(function (p) { return p.a.id + '|' + p.b.id; });
  try { logChange('duplicates', 'Cross-serving check', pairs.length + ' pair(s) found'); } catch (e) {}
  return { pairs: pairs, message: msg };
}

/* ===== Print all recipe cards ===== */
function printAllCards() {
  printRecipeCards(null);
}
function cardEnhanceView(id) {
  var vb = document.getElementById('viewBody');
  if (!vb) return;
  var tb = vb.querySelector('.toolbar');
  if (!tb || vb.querySelector('#vCards')) return;
  tb.insertAdjacentHTML('beforeend', '<button id="vCards" title="Print this recipe as a filing card">Cards</button>');
  var b = document.getElementById('vCards');
  if (b) b.onclick = function () { printRecipeCards([id]); };
}

var _cardBaseOpenView = openView;
openView = function (id) {
  var out = _cardBaseOpenView(id);
  if (out && typeof out.then === 'function') {
    return out.then(function () { try { cardEnhanceView(id); } catch (e) {} });
  }
  try { cardEnhanceView(id); } catch (e) {}
  return out;
};

/* Cost display inside the recipe view. */
function cardEnhanceCost(id) {
  var vb = document.getElementById('viewBody');
  if (!vb || vb.querySelector('#vCostLine')) return;
  var r = (state.recipes || []).find(function (x) { return x.id === id; });
  if (!r) return;
  var c = recipeCostPerServing(r);
  var line = document.createElement('p');
  line.id = 'vCostLine';
  line.className = 'small';
  if (c.perServing != null) {
    line.innerHTML = 'Estimated cost: <strong>' + money(c.perServing) + '</strong> per serving <span class="dim">(' +
      money(c.cents) + ' total, ' + c.priced + '/' + c.lines + ' lines priced)</span>';
  } else {
    line.innerHTML = '<span class="dim">Cost estimate needs priced ingredients - add costs in Pantry for accuracy.</span>';
  }
  var anchor = vb.querySelector('.toolbar') || vb.querySelector('h2');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(line, anchor);
  else vb.insertBefore(line, vb.firstChild);
}

var _cardCostBase = openView;
openView = function (id) {
  var out = _cardCostBase(id);
  if (out && typeof out.then === 'function') {
    return out.then(function () { try { cardEnhanceCost(id); } catch (e) {} });
  }
  try { cardEnhanceCost(id); } catch (e) {}
  return out;
};

function initCardsUI() {
  var b = document.getElementById('btnCardsAll');
  if (b) b.onclick = function () { printRecipeCards(null); };

  // Fold cross-serving pairs into the existing Find duplicates report so there
  // is one place to look rather than a separate orphan check.
  var dupBtn = document.getElementById('btnDupes');
  if (dupBtn && typeof findAllDuplicates === 'function') {
    var prevDup = dupBtn.onclick;
    dupBtn.onclick = function (e) {
      if (prevDup) prevDup.call(this, e);
      var res = offerCrossServingMerge();
      if (res && res.pairs.length) {
        setTimeout(function () { toast(res.pairs.length + ' same-recipe/different-servings pair(s) found'); }, 400);
      }
    };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCardsUI);
else initCardsUI();