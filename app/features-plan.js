/* Recipe Box v3 - planning & shopping layer.
   Week planner with repeat meals and per-meal servings, scalable shopping
   from calendar entries, prices/budget totals, print and share. */

var _baseAddToShop = addToShop;
var _baseBuildShopFromPlan = buildShopFromPlan;
var _baseRenderShopUI = renderShopUI;
var _baseRenderCalendar = renderCalendar;

/* ===== Shared ingredient syntax helpers =====
   In a recipe, an ingredient line may be:
     ## Section title
     2 cups flour | note: sifted | sub: bread flour
   The main text is used for shopping; note/sub stay in the recipe view. */
function isIngHeader(s) {
  return /^\s*#{1,3}\s+\S/.test(String(s || ''));
}
function ingHeaderText(s) {
  return String(s || '').replace(/^\s*#{1,3}\s+/, '').trim();
}
function splitIngExtra(s) {
  var raw = String(s == null ? '' : s);
  var parts = raw.split(/\s+\|\s+/);
  var main = parts.shift() || '';
  var note = '';
  var sub = '';
  parts.forEach(function (p) {
    var m = /^(note|sub|subs|substitute|substitutes)\s*:\s*(.*)$/i.exec(p);
    if (m) {
      if (/^sub/i.test(m[1])) sub = sub ? sub + '; ' + m[2] : m[2];
      else note = note ? note + ' ' + m[2] : m[2];
    } else {
      note = note ? note + ' ' + p : p;
    }
  });
  return { main: main.trim(), note: note.trim(), sub: sub.trim() };
}
function fmtIngMain(s, factor) {
  return fmtIng(splitIngExtra(s).main, factor || 1);
}
function ingGroups(r) {
  var groups = [];
  var cur = { title: '', items: [] };
  ((r && r.ing) || []).forEach(function (s, idx) {
    if (isIngHeader(s)) {
      if (cur.items.length || cur.title) groups.push(cur);
      cur = { title: ingHeaderText(s), items: [] };
    } else {
      cur.items.push({ text: s, idx: idx });
    }
  });
  if (cur.items.length || cur.title) groups.push(cur);
  return groups;
}

/* ===== Servings & date helpers ===== */
function parseServings(v) {
  if (typeof v === 'number') return v > 0 ? v : 0;
  var m = String(v == null ? '' : v).match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  if (m[2]) n = n / parseFloat(m[2]);
  return isFinite(n) && n > 0 ? n : 0;
}
function entryFactor(entry, r) {
  var target = parseFloat(entry && entry.servings);
  var base = parseServings(r && r.servings);
  if (target > 0 && base > 0) return target / base;
  return 1;
}
function openRecipeAt(id, servings) {
  var r = (state.recipes || []).find(function (x) { return x.id === id; });
  if (!r) { toast('Recipe not found'); return; }
  var base = parseServings(r.servings);
  var target = parseFloat(servings);
  state.scale = state.scale || {};
  state.scale[id] = (target > 0 && base > 0) ? target / base : 1;
  openView(id);
}
function parseISODate(s) {
  var p = String(s || '').split('-');
  return new Date(parseInt(p[0], 10), (parseInt(p[1], 10) || 1) - 1, parseInt(p[2], 10) || 1, 12, 0, 0, 0);
}
function isoOf(d) {
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}
function mondayISO(dateStr) {
  var d = dateStr ? parseISODate(dateStr) : new Date();
  d.setHours(12, 0, 0, 0);
  var day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return isoOf(d);
}
function addDaysISO(s, n) {
  var d = parseISODate(s);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
function dayName(s) {
  return parseISODate(s).toLocaleDateString(undefined, { weekday: 'short' });
}
function shortDate(s) {
  return parseISODate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function mealOrder(m) {
  var order = { Breakfast: 0, Lunch: 1, Dinner: 2, Snack: 3 };
  return order[m] == null ? 9 : order[m];
}

/* ===== Shopping core ===== */
function ensureShop() {
  if (!state.shopDone) state.shopDone = { '__items__': [] };
  if (!Array.isArray(state.shopDone['__items__'])) state.shopDone['__items__'] = [];
  return state.shopDone['__items__'];
}
function shopTotals(items) {
  var total = 0;
  var priced = 0;
  var done = 0;
  (items || []).forEach(function (it) {
    if (it.done) done++;
    var v = parseFloat(it.price);
    if (isFinite(v) && v > 0) { total += v; priced++; }
  });
  return { n: (items || []).length, done: done, total: total, priced: priced };
}
function subtractPantryItems(items) {
  var have = {};
  (state.pantry || []).forEach(function (p) { if (p && p.have) have[pantryKey(p.name)] = 1; });
  return (items || []).filter(function (it) { return !have[pantryKey(it.text)]; });
}

mergeShopItems = function (items) {
  var map = {};
  var order = [];
  (items || []).forEach(function (it) {
    var raw = String((it && it.text) || it || '').trim();
    if (!raw || isIngHeader(raw)) return;
    var p = parseQtyText(raw);
    var k = p.kind === 'raw' ? ('raw|' + normItemKey(raw)) : shopItemKey(p);
    if (!k) return;
    var f = (p.unit && UNIT_DEFS[p.unit]) ? UNIT_DEFS[p.unit].f : 1;
    var cur = map[k];
    if (!cur) {
      cur = map[k] = {
        key: k, text: raw, done: !!(it && it.done),
        aisle: (it && it.aisle) || guessAisle(raw),
        price: (it && it.price !== '' && it.price != null) ? it.price : '',
        _p: p, _qty: p.kind === 'raw' ? 0 : (p.qty || 0) * f, _n: 1
      };
      order.push(k);
    } else {
      cur._n++;
      if (it && it.done) cur.done = true;
      if (p.kind !== 'raw' && cur._p.kind !== 'raw') cur._qty += (p.qty || 0) * f;
      if ((cur.price === '' || cur.price == null) && it && it.price !== '' && it.price != null) cur.price = it.price;
    }
  });
  return order.map(function (k) {
    var o = map[k];
    var p = o._p;
    if (p.kind === 'raw') {
      if (o._n > 1 && o.text.indexOf(' (x') < 0) o.text = o.text + ' (x' + o._n + ')';
      return { key: o.key, text: o.text, done: o.done, aisle: o.aisle, price: o.price };
    }
    if (o._n <= 1) return { key: o.key, text: o.text, done: o.done, aisle: o.aisle, price: o.price };
    var unit = p.unit || '';
    var name = p.name || '';
    var f2 = (unit && UNIT_DEFS[unit]) ? UNIT_DEFS[unit].f : 1;
    var q = o._qty / f2;
    if (!unit) name = adjustCountName(name, q);
    var text = fmtQty(q) + (unit ? (' ' + unitLabel(unit, q)) : '') + (name ? (' ' + name) : '');
    return { key: o.key, text: text.trim(), done: o.done, aisle: o.aisle || guessAisle(text), price: o.price };
  });
};

addToShop = function (r, factor) {
  ensureShop();
  if (!r) return;
  var existing = state.shopDone['__items__'].slice();
  (r.ing || []).forEach(function (i) {
    if (isIngHeader(i)) return;
    var t = fmtIngMain(i, factor || 1).trim();
    if (!t) return;
    existing.push({ key: normItemKey(t) || t.toLowerCase(), text: t, done: false, aisle: guessAisle(t) });
  });
  state.shopDone['__items__'] = mergeShopItems(existing);
  save();
  renderShopUI();
};

buildShopFromPlan = function (ids, opts) {
  opts = opts || {};
  ids = ids || state.plan || [];
  if (!ids.length) { toast('No recipes to add'); return; }
  ensureShop();
  var existing = state.shopDone['__items__'].slice();
  ids.forEach(function (id) {
    var r = (state.recipes || []).find(function (x) { return x.id === id; });
    if (!r) return;
    (r.ing || []).forEach(function (i) {
      if (isIngHeader(i)) return;
      var t = fmtIngMain(i, 1).trim();
      if (!t) return;
      existing.push({ key: normItemKey(t) || t.toLowerCase(), text: t, done: false, aisle: guessAisle(i) });
    });
  });
  var merged = mergeShopItems(existing);
  if (!opts.keepPantry) merged = subtractPantryItems(merged);
  state.shopDone['__items__'] = merged;
  save();
  renderShopUI();
  logChange('shop', 'Shopping list', 'Added ' + ids.length + ' planned meal(s)');
  toast('Added ' + ids.length + ' recipe(s) to shopping list');
};

function buildShopFromCalendar(from, to) {
  var entries = (state.calendar || []).filter(function (c) {
    return (!from || c.date >= from) && (!to || c.date <= to);
  });
  if (!entries.length) { toast('No planned meals in that date range'); return false; }
  ensureShop();
  var existing = state.shopDone['__items__'].slice();
  var count = 0;
  entries.forEach(function (c) {
    var r = (state.recipes || []).find(function (x) { return x.id === c.recipeId; });
    if (!r) return;
    var f = entryFactor(c, r);
    count++;
    (r.ing || []).forEach(function (i) {
      if (isIngHeader(i)) return;
      var t = fmtIngMain(i, f).trim();
      if (!t) return;
      existing.push({ key: normItemKey(t) || t.toLowerCase(), text: t, done: false, aisle: guessAisle(t) });
    });
  });
  var merged = subtractPantryItems(mergeShopItems(existing));
  state.shopDone['__items__'] = merged;
  save();
  renderShopUI();
  logChange('shop', 'Shopping list', 'Added ' + count + ' calendar meal(s)');
  toast('Added ' + count + ' planned meal(s) to shopping list');
  return true;
}

function updateShopTotals() {
  var items = ensureShop();
  var t = shopTotals(items);
  var s = t.n + ' item(s) \u00b7 ' + t.done + ' done \u00b7 $' + t.total.toFixed(2);
  if (t.priced < t.n) s += ' (' + (t.n - t.priced) + ' without price)';
  var budget = parseFloat(state.shopBudget);
  if (isFinite(budget) && budget > 0) {
    var diff = budget - t.total;
    s += ' \u00b7 Budget $' + budget.toFixed(2) + ' \u00b7 ' + (diff >= 0 ? '$' + diff.toFixed(2) + ' left' : '$' + Math.abs(diff).toFixed(2) + ' over');
  }
  var el = document.getElementById('shopTotals');
  if (el) el.textContent = s;
  var bi = document.getElementById('shopBudgetIn');
  if (bi && document.activeElement !== bi) bi.value = state.shopBudget || '';
}

renderShopUI = function () {
  var el = document.getElementById('shopList');
  if (!el) return;
  var items = ensureShop();
  var groups = {};
  items.forEach(function (it, i) {
    var a = it.aisle || guessAisle(it.text);
    if (!groups[a]) groups[a] = [];
    groups[a].push({ it: it, i: i });
  });
  var aisles = Object.keys(groups).sort();
  var h = '';
  if (aisles.length) {
    h += aisles.map(function (a) {
      return '<div class="shop-group"><div class="pill" style="margin:6px 0">' + esc(a) + '</div>' +
        groups[a].map(function (x) {
          var it = x.it;
          return '<div class="itemrow shop-row"><label class="ck" style="flex:1"><input type="checkbox" data-si="' + x.i + '" ' + (it.done ? 'checked' : '') + '> <span class="' + (it.done ? 'shop-done' : '') + '">' + esc(it.text) + '</span></label>' +
            '<input class="price-in" type="number" min="0" step="0.01" inputmode="decimal" placeholder="$" value="' + esc(it.price != null ? it.price : '') + '" data-sp="' + x.i + '" aria-label="Price for ' + esc(it.text) + '">' +
            '<button data-sd="' + x.i + '" aria-label="Remove">\u00d7</button></div>';
        }).join('') + '</div>';
    }).join('');
  } else {
    h = '<div class="small">No items yet. Open a recipe and click "Add to list", add planned meals, pick a recipe, or type a custom item.</div>';
  }
  el.innerHTML = h;
  updateShopTotals();
  el.onchange = function (e) {
    var cb = e.target.closest('input[data-si]');
    if (cb) {
      var idx = +cb.dataset.si;
      if (items[idx]) items[idx].done = cb.checked;
      save();
      renderShopUI();
      return;
    }
    var pr = e.target.closest('input[data-sp]');
    if (pr) {
      var i2 = +pr.dataset.sp;
      if (items[i2]) {
        var v = parseFloat(pr.value);
        items[i2].price = (isFinite(v) && v > 0) ? Math.round(v * 100) / 100 : '';
        save();
        updateShopTotals();
      }
    }
  };
  el.onclick = function (e) {
    var b = e.target.closest('button[data-sd]');
    if (!b) return;
    items.splice(+b.dataset.sd, 1);
    save();
    renderShopUI();
  };
  var sel = document.getElementById('shopAddRecipe');
  if (sel) {
    sel.innerHTML = '<option value="">Add ingredients from a recipe?</option>' +
      state.recipes.slice().sort(function (a, b) { return a.title.localeCompare(b.title); })
        .map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.title) + '</option>'; }).join('');
  }
};

function shopText() {
  var items = ensureShop().filter(function (x) { return !x.done; });
  var groups = {};
  items.forEach(function (it) {
    var a = it.aisle || guessAisle(it.text);
    (groups[a] = groups[a] || []).push(it);
  });
  var lines = [];
  Object.keys(groups).sort().forEach(function (a) {
    lines.push(a + ':');
    groups[a].forEach(function (it) {
      lines.push('  - ' + it.text + (it.price ? (' ($' + Number(it.price).toFixed(2) + ')') : ''));
    });
  });
  var t = shopTotals(items);
  lines.push('');
  lines.push('Estimated total: $' + t.total.toFixed(2));
  var budget = parseFloat(state.shopBudget);
  if (isFinite(budget) && budget > 0) lines.push('Budget: $' + budget.toFixed(2));
  return lines.join('\n');
}
function printShoppingList() {
  var items = ensureShop().filter(function (x) { return !x.done; });
  if (!items.length) { toast('Nothing to print'); return; }
  var groups = {};
  items.forEach(function (it) {
    var a = it.aisle || guessAisle(it.text);
    (groups[a] = groups[a] || []).push(it);
  });
  var t = shopTotals(items);
  var budget = parseFloat(state.shopBudget);
  var body = '<h1>Shopping list</h1><p class="meta">' + new Date().toLocaleString() + '</p>';
  Object.keys(groups).sort().forEach(function (a) {
    body += '<h2>' + esc(a) + '</h2><ul>' + groups[a].map(function (it) {
      return '<li><span class="box"></span>' + esc(it.text) + (it.price ? (' <em>$' + Number(it.price).toFixed(2) + '</em>') : '') + '</li>';
    }).join('') + '</ul>';
  });
  body += '<p><strong>Estimated total: $' + t.total.toFixed(2) + '</strong>';
  if (isFinite(budget) && budget > 0) body += ' \u00b7 Budget $' + budget.toFixed(2) + ' \u00b7 ' + (budget - t.total >= 0 ? ('$' + (budget - t.total).toFixed(2) + ' left') : ('$' + Math.abs(budget - t.total).toFixed(2) + ' over'));
  body += '</p>';
  var html = '<!doctype html><meta charset="utf-8"><title>Shopping list</title><style>' +
    'body{font:16px/1.5 Georgia,serif;max-width:720px;margin:24px auto;padding:0 18px}h1{margin:0 0 4px}h2{font-size:1rem;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ccc}ul{list-style:none;padding:0;margin:0}li{padding:5px 0;border-bottom:1px dotted #ddd}.box{display:inline-block;width:12px;height:12px;border:1.5px solid #444;margin-right:8px;vertical-align:-1px}.meta{color:#666;font-size:.85rem}em{color:#555;font-style:normal;font-size:.85rem}@media print{body{margin:0}}' +
    '</style><button onclick="window.print()" style="float:right">Print / Save as PDF</button>' + body;
  var w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the list'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(function () { try { w.focus(); } catch (e) {} }, 100);
}
function shareShoppingList() {
  var text = shopText();
  if (navigator.share) {
    navigator.share({ title: 'Shopping list', text: text }).catch(function () {});
  } else {
    copyText(text);
    toast('Shopping list copied to clipboard');
  }
}

/* ===== Calendar / week planner ===== */
renderCalendar = function () {
  if (!document.getElementById('calList')) return;
  var sel = document.getElementById('calRecipe');
  if (sel) {
    sel.innerHTML = '<option value="">Select...</option>' + state.recipes.slice()
      .sort(function (a, b) { return a.title.localeCompare(b.title); })
      .map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.title) + '</option>'; }).join('');
  }
  state.calWeekStart = mondayISO(state.calWeekStart || new Date().toISOString().slice(0, 10));
  var start = state.calWeekStart;
  var days = [];
  for (var i = 0; i < 7; i++) days.push(addDaysISO(start, i));
  var weekLabel = document.getElementById('calWeekLabel');
  if (weekLabel) weekLabel.textContent = shortDate(days[0]) + ' - ' + shortDate(days[6]);
  var bySlot = {};
  (state.calendar || []).forEach(function (c, idx) {
    var key = c.date + '|' + c.meal;
    (bySlot[key] = bySlot[key] || []).push({ c: c, idx: idx });
  });
  var meals = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  var grid = '<div class="weekgrid">';
  grid += '<div class="weekcol weekhead"></div>';
  days.forEach(function (d) {
    grid += '<div class="weekcol weekhead"><strong>' + esc(dayName(d)) + '</strong><div class="small">' + esc(shortDate(d)) + '</div></div>';
  });
  meals.forEach(function (m) {
    grid += '<div class="weekcol weekrowhead">' + esc(m) + '</div>';
    days.forEach(function (d) {
      var list = bySlot[d + '|' + m] || [];
      grid += '<div class="weekcol weekcell">' + (list.length ? list.map(function (x) {
        var r = state.recipes.find(function (y) { return y.id === x.c.recipeId; });
        var title = r ? r.title : '(missing)';
        var serv = x.c.servings || (r && r.servings) || '';
        return '<div class="week-entry" data-calopen="' + esc(x.c.recipeId) + '" data-calserv="' + esc(x.c.servings || '') + '" title="' + esc(title) + '">' +
          '<span class="we-title">' + esc(title) + '</span>' + (serv ? '<span class="small">' + esc(String(serv)) + ' serving(s)</span>' : '') +
          '<span class="we-actions"><button data-calrep="' + x.idx + '" title="Repeat next week" aria-label="Repeat next week">+7</button><button data-calrm="' + x.idx + '" title="Remove" aria-label="Remove">\u00d7</button></span></div>';
      }).join('') : '<span class="small week-empty">+</span>') + '</div>';
    });
  });
  grid += '</div>';
  var wrap = document.getElementById('calWeekGrid');
  if (wrap) {
    wrap.innerHTML = grid;
    wrap.onclick = function (e) {
      var rm = e.target.closest('button[data-calrm]');
      if (rm) {
        state.calendar.splice(+rm.dataset.calrm, 1);
        save(); renderCalendar();
        return;
      }
      var rep = e.target.closest('button[data-calrep]');
      if (rep) {
        var ent = state.calendar[+rep.dataset.calrep];
        if (ent) {
          state.calendar.push(Object.assign({}, ent, { date: addDaysISO(ent.date, 7), repeatOf: ent.id || null }));
          save(); renderCalendar();
          toast('Repeated next week');
        }
        return;
      }
      var open = e.target.closest('[data-calopen]');
      if (open) {
        var rid = open.dataset.calopen;
        var servings = open.dataset.calserv;
        if (servings) openRecipeAt(rid, servings);
        else openView(rid);
      }
    };
  }
  var items = (state.calendar || []).slice().sort(function (a, b) {
    return (a.date + '|' + ('0' + mealOrder(a.meal))).localeCompare(b.date + '|' + ('0' + mealOrder(b.meal)));
  });
  var list = document.getElementById('calList');
  if (list) {
    list.innerHTML = items.length ? items.map(function (c, i) {
      var idx = (state.calendar || []).indexOf(c);
      var r = state.recipes.find(function (x) { return x.id === c.recipeId; });
      return '<div class="cal-item"><span class="pill">' + esc(c.date) + '</span><span class="pill">' + esc(c.meal) + '</span>' +
        '<span style="flex:1">' + esc(r ? r.title : '(missing)') + (c.servings ? ' <span class="small">(' + esc(c.servings) + ' servings)</span>' : '') + '</span>' +
        '<button data-copen="' + esc(c.recipeId) + '" data-cserv="' + esc(c.servings || '') + '">Open</button>' +
        '<button data-crm="' + idx + '" aria-label="Remove">\u00d7</button></div>';
    }).join('') : '<div class="small">No meals scheduled.</div>';
    list.onclick = function (e) {
      var b = e.target.closest('button[data-crm]');
      if (b) { state.calendar.splice(+b.dataset.crm, 1); save(); renderCalendar(); return; }
      var o = e.target.closest('button[data-copen]');
      if (o) {
        if (o.dataset.cserv) openRecipeAt(o.dataset.copen, o.dataset.cserv);
        else openView(o.dataset.copen);
      }
    };
  }
};

function copyWeekForward() {
  var start = mondayISO(state.calWeekStart || new Date().toISOString().slice(0, 10));
  var end = addDaysISO(start, 6);
  var add = (state.calendar || []).filter(function (c) { return c.date >= start && c.date <= end; })
    .map(function (c) { return Object.assign({}, c, { date: addDaysISO(c.date, 7), copiedFrom: c.date }); });
  if (!add.length) { toast('No meals in this week to copy'); return; }
  state.calendar = (state.calendar || []).concat(add);
  save();
  renderCalendar();
  toast('Copied ' + add.length + ' meal(s) to next week');
}

/* Printable week plan - one page for the fridge. */
function weekEntries(from, to) {
  return (state.calendar || []).filter(function (c) {
    return (!from || c.date >= from) && (!to || c.date <= to);
  });
}

function printWeekPlan() {
  var start = mondayISO(state.calWeekStart || new Date().toISOString().slice(0, 10));
  var end = addDaysISO(start, 6);
  var entries = weekEntries(start, end);

  if (!entries.length) {
    toast('No meals planned for ' + shortDate(start) + ' - ' + shortDate(end));
    return;
  }

  var meals = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  var bySlot = {};
  entries.forEach(function (c) {
    var k = c.date + '|' + c.meal;
    (bySlot[k] = bySlot[k] || []).push(c);
  });

  var rows = '';
  for (var d = 0; d < 7; d++) {
    var day = addDaysISO(start, d);
    var cells = meals.map(function (m) {
      var list = bySlot[day + '|' + m] || [];
      if (!list.length) return '<td class="empty"></td>';
      return '<td>' + list.map(function (c) {
        var r = (state.recipes || []).find(function (x) { return x.id === c.recipeId; });
        var title = r ? r.title : '(missing recipe)';
        var serv = c.servings || (r && r.servings) || '';
        return '<div class="meal"><span class="mt">' + esc(title) + '</span>' +
          (serv ? '<span class="ms">' + esc(String(serv)) + ' servings</span>' : '') + '</div>';
      }).join('') + '</td>';
    }).join('');
    rows += '<tr><th class="day">' + esc(dayName(day)) + '<span class="dnum">' + esc(shortDate(day)) + '</span></th>' + cells + '</tr>';
  }

  var html = '<!doctype html><meta charset="utf-8"><title>Meal plan ' + esc(start) + '</title><style>' +
    '@page{margin:14mm}body{font:15px/1.45 Georgia,serif;margin:22px auto;padding:0 16px;max-width:900px;color:#111}' +
    'h1{font:700 1.5rem system-ui,sans-serif;margin:0 0 2px}.sub{color:#666;font-size:.85rem;margin:0 0 14px}' +
    'table{width:100%;border-collapse:collapse;table-layout:fixed}' +
    'th,td{border:1px solid #bbb;padding:6px 7px;vertical-align:top}' +
    'thead th{background:#f0f0ee;font:600 .72rem system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;text-align:left}' +
    'th.day{font:600 .8rem system-ui,sans-serif;white-space:nowrap;width:76px;background:#fafafa}' +
    '.dnum{display:block;font-weight:400;color:#777;font-size:.7rem}' +
    '.meal{margin-bottom:6px}.mt{display:block;font-weight:600}.ms{display:block;color:#777;font-size:.78rem}' +
    'td.empty{background:#fcfcfc}' +
    '.notes{margin-top:14px;border-top:1px solid #ccc;padding-top:8px;font-size:.85rem;color:#555}' +
    '@media print{body{margin:0}.noprint{display:none}}' +
    '</style>' +
    '<button class="noprint" onclick="window.print()" style="float:right;margin-bottom:10px">Print / Save as PDF</button>' +
    '<h1>Meal plan</h1>' +
    '<p class="sub">' + esc(shortDate(start)) + ' \u2013 ' + esc(shortDate(end)) + ' \u00b7 ' +
    entries.length + ' meal(s) planned</p>' +
    '<table><thead><tr><th></th>' + meals.map(function (m) { return '<th>' + esc(m) + '</th>'; }).join('') + '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div class="notes">Notes: ____________________________________________________________</div>';

  var w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the week plan'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(function () { try { w.focus(); } catch (e) {} }, 100);
}

function initPlanPrintUI() {
  var b = document.getElementById('calPrint');
  if (b) b.onclick = printWeekPlan;
}

function initPlanUI() {
  var add = document.getElementById('calAdd');
  if (add) add.onclick = function () {
    var date = document.getElementById('calDate').value;
    var meal = document.getElementById('calMeal').value;
    var rid = document.getElementById('calRecipe').value;
    var servings = (document.getElementById('calServings') || {}).value || '';
    var repeat = Math.max(1, Math.min(52, parseInt((document.getElementById('calRepeat') || {}).value, 10) || 1));
    if (!date || !rid) { toast('Pick date and recipe'); return; }
    for (var i = 0; i < repeat; i++) {
      state.calendar.push({ date: addDaysISO(date, 7 * i), meal: meal, recipeId: rid, servings: servings });
    }
    save();
    renderCalendar();
    logChange('calendar', 'Planned meal', date + ' ' + meal + (repeat > 1 ? (' (' + repeat + ' weeks)') : ''));
    toast(repeat > 1 ? ('Added ' + repeat + ' weekly meals') : 'Added to calendar');
  };
  var build = document.getElementById('calBuild');
  if (build) build.onclick = function () {
    var from = document.getElementById('calFrom').value || '0000';
    var to = document.getElementById('calTo').value || '9999';
    if (buildShopFromCalendar(from, to)) {
      try { document.getElementById('dCalendar').close(); } catch (e) {}
      openShop();
    }
  };
  var prev = document.getElementById('calPrev');
  if (prev) prev.onclick = function () { state.calWeekStart = addDaysISO(mondayISO(state.calWeekStart), -7); saveLocalOnly(); renderCalendar(); };
  var next = document.getElementById('calNext');
  if (next) next.onclick = function () { state.calWeekStart = addDaysISO(mondayISO(state.calWeekStart), 7); saveLocalOnly(); renderCalendar(); };
  var today = document.getElementById('calToday');
  if (today) today.onclick = function () { state.calWeekStart = mondayISO(new Date().toISOString().slice(0, 10)); saveLocalOnly(); renderCalendar(); };
  var copy = document.getElementById('calCopyWeek');
  if (copy) copy.onclick = copyWeekForward;
  initPlanPrintUI();

  var budget = document.getElementById('shopBudgetIn');
  if (budget) {
    budget.oninput = function () { state.shopBudget = this.value.trim(); updateShopTotals(); };
    budget.onchange = function () { state.shopBudget = this.value.trim(); save(); };
  }
  var print = document.getElementById('shopPrint');
  if (print) print.onclick = printShoppingList;
  var share = document.getElementById('shopShare');
  if (share) share.onclick = shareShoppingList;
  var estimate = document.getElementById('shopEstimate');
  if (estimate) estimate.onclick = function () {
    ensureShop().forEach(function (it) {
      if (it.price !== '' && it.price != null) return;
      var key = pantryKey(it.text);
      var p = (state.pantry || []).find(function (x) { return pantryKey(x.name) === key; });
      if (p && p.cost) {
        var v = parseFloat(p.cost);
        if (isFinite(v) && v > 0) it.price = Math.round(v * 100) / 100;
      }
    });
    save();
    renderShopUI();
    toast('Filled prices from pantry items where available');
  };
}
