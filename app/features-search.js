/* Recipe Box v3 - search with operators.
   Supports tag:, cat:, ing:, title:, step:, note:, under:/over:, serves:,
   rating:, fav, photo, cooked, id:, -exclusions and "quoted phrases".
   Plain words still behave exactly as before (all must appear).

   app.js delegates to searchMatch() only when the query contains an operator
   or a quote, so ordinary searches keep the original fast substring path. */

function searchHasOperators(q) {
  return /(^|\s)-?[a-zA-Z]+:/.test(String(q || '')) ||
    /(^|\s)(fav|favorite|favourites?|photo|photos|hasphoto|cooked|uncooked)\b/i.test(String(q || '')) ||
    /"/.test(String(q || '')) ||
    /(^|\s)-\S/.test(String(q || ''));
}

function parseTimeMinutes(str) {
  var s = String(str || '').toLowerCase();
  var total = 0, found = false;
  var h = s.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|hours|h)\b/);
  if (h) { total += parseFloat(h[1]) * 60; found = true; }
  var m = s.match(/(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes)\b/);
  if (m) { total += parseFloat(m[1]); found = true; }
  if (!found) {
    var bare = s.match(/(\d+(?:\.\d+)?)/);
    if (bare) { total = parseFloat(bare[1]); }
  }
  return total;
}

function searchOperandValue(text) {
  var v = String(text || '').trim().replace(/^["']|["']$/g, '');
  // "under:30", "under:<=30", "under:30 min" all work.
  var m = v.match(/^(<=|>=|<|>|=)?\s*(\d+(?:\.\d+)?)/);
  if (m) {
    var op = m[1] || '';
    var n = parseFloat(m[2]);
    return { op: op, n: n };
  }
  return { op: '', n: null, raw: v.toLowerCase() };
}

/* Tokenise on spaces, but keep quoted phrases together. */
function searchTokenize(q) {
  var out = [];
  var s = String(q || '');
  var re = /(-?)([a-zA-Z]+):\(?([^)]*"?|[^)\s]+)"?|(-?)("([^"]*)"|[^\s]+)/g;
  var m;
  // Simpler, predictable scan: walk the string.
  var i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    var neg = false;
    if (s[i] === '-') { neg = true; i++; }
    var start = i;
    var inQuote = false;
    while (i < s.length) {
      if (s[i] === '"') { inQuote = !inQuote; i++; continue; }
      if (!inQuote && /\s/.test(s[i])) break;
      i++;
    }
    var tok = s.slice(start, i).trim();
    // Quotes were consumed as grouping characters; they are not part of the term.
    tok = tok.replace(/^"+|"+$/g, '').trim();
    if (!tok) continue;
    out.push({ text: tok, neg: neg });
  }
  return out;
}

function searchParse(q) {
  var tokens = searchTokenize(q);
  var parsed = { terms: [], ops: [], flags: [], errors: [] };

  tokens.forEach(function (t) {
    var raw = t.text;
    var m = raw.match(/^([a-zA-Z]+):(.*)$/);
    if (m) {
      var key = m[1].toLowerCase();
      var val = m[2];
      var negate = t.neg;
      if (key === 'tag') { parsed.ops.push({ kind: 'tag', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'cat' || key === 'category') { parsed.ops.push({ kind: 'cat', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'ing' || key === 'ingredient' || key === 'ingredients') { parsed.ops.push({ kind: 'ing', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'title') { parsed.ops.push({ kind: 'title', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'step' || key === 'steps' || key === 'method') { parsed.ops.push({ kind: 'step', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'note' || key === 'notes') { parsed.ops.push({ kind: 'note', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'id') { parsed.ops.push({ kind: 'id', val: val.toLowerCase(), neg: negate }); return; }
      if (key === 'under' || key === 'max' || key === 'over' || key === 'min') {
        var o = searchOperandValue(val);
        var kind = (key === 'under' || key === 'max') ? 'under' : 'over';
        // "under:<=30" / "over:>=30" keep their explicit comparator.
        if (o.n == null) { parsed.errors.push('"' + raw + '" needs a number'); return; }
        parsed.ops.push({ kind: kind, n: o.n, cmp: o.op || (kind === 'under' ? '<=' : '>='), neg: negate });
        return;
      }
      if (key === 'serves' || key === 'servings') {
        var sv = searchOperandValue(val);
        if (sv.n == null) { parsed.errors.push('"' + raw + '" needs a number'); return; }
        parsed.ops.push({ kind: 'serves', n: sv.n, cmp: sv.op || '=', neg: negate });
        return;
      }
      if (key === 'rating') {
        var rv = searchOperandValue(val);
        if (rv.n == null) { parsed.errors.push('"' + raw + '" needs a number'); return; }
        parsed.ops.push({ kind: 'rating', n: rv.n, cmp: rv.op || '>=', neg: negate });
        return;
      }
      parsed.errors.push('unknown operator "' + key + ':"');
      return;
    }

    var low = raw.toLowerCase();
    if (low === 'fav' || low === 'favorite' || low === 'favourite' || low === 'favorites' || low === 'favourites') {
      parsed.flags.push({ kind: 'fav', neg: t.neg }); return;
    }
    if (low === 'photo' || low === 'photos' || low === 'hasphoto') {
      parsed.flags.push({ kind: 'photo', neg: t.neg }); return;
    }
    if (low === 'cooked') { parsed.flags.push({ kind: 'cooked', neg: t.neg }); return; }
    if (low === 'uncooked') { parsed.flags.push({ kind: 'cooked', neg: true }); return; }

    parsed.terms.push({ val: low, neg: t.neg });
  });

  return parsed;
}

function searchCmp(a, cmp, b) {
  if (cmp === '<') return a < b;
  if (cmp === '<=') return a <= b;
  if (cmp === '>') return a > b;
  if (cmp === '>=') return a >= b;
  return a === b;
}

function searchRecipeHay(r, field) {
  switch (field) {
    case 'title': return String(r.title || '').toLowerCase();
    case 'ing': return (r.ing || []).join(' ').toLowerCase();
    case 'step': return (r.steps || []).join(' ').toLowerCase();
    case 'note': return String(r.notes || '').toLowerCase() + ' ' + (r.nutrition || '');
    default:
      return (r.title + ' ' + (r.ing || []).join(' ') + ' ' + (r.steps || []).join(' ') + ' ' +
        (r.notes || '') + ' ' + ((r.tags || []).join(' ')) + ' ' + (r.nutrition || '')).toLowerCase();
  }
}

function searchMatchOp(r, op) {
  var res;
  switch (op.kind) {
    case 'tag':
      res = ((r.tags || []).join(' ').toLowerCase().indexOf(op.val) > -1); break;
    case 'cat':
      res = ((r.cats || []).join(' ').toLowerCase().indexOf(op.val) > -1) ||
        String(catLabel(r) || '').toLowerCase().indexOf(op.val) > -1; break;
    case 'title': res = searchRecipeHay(r, 'title').indexOf(op.val) > -1; break;
    case 'ing': res = searchRecipeHay(r, 'ing').indexOf(op.val) > -1; break;
    case 'step': res = searchRecipeHay(r, 'step').indexOf(op.val) > -1; break;
    case 'note': res = searchRecipeHay(r, 'note').indexOf(op.val) > -1; break;
    case 'id': res = String(r.id || '').toLowerCase() === op.val; break;
    case 'under': res = searchCmp(parseTimeMinutes(r.time), op.cmp, op.n); break;
    case 'over': res = searchCmp(parseTimeMinutes(r.time), op.cmp, op.n); break;
    case 'serves': res = searchCmp(parseServings(r.servings), op.cmp, op.n); break;
    case 'rating': res = searchCmp(parseFloat(r.rating) || 0, op.cmp, op.n); break;
    default: res = false;
  }
  return op.neg ? !res : res;
}

function searchMatchFlag(r, f) {
  var res;
  switch (f.kind) {
    case 'fav': res = !!r.fav; break;
    case 'photo': res = !!(r.photos && r.photos.length); break;
    case 'cooked': res = !!(r.cookCount || (r.cookLog && r.cookLog.length) || r.lastCooked); break;
    default: res = false;
  }
  return f.neg ? !res : res;
}

/* Main predicate used by app.js. */
function searchMatch(r, q) {
  var query = String(q || '').trim();
  if (!query) return true;
  if (!searchHasOperators(query)) {
    var hay = searchRecipeHay(r, 'all').toLowerCase() + ' ' + getMain(r).join(' ').toLowerCase();
    return hay.indexOf(query.toLowerCase()) > -1;
  }

  var p = searchParse(query);

  // If part of the query was invalid, silently matching everything is worse
  // than matching nothing - the help line explains what was wrong.
  if (p.errors.length) return false;

  for (var i = 0; i < p.terms.length; i++) {
    var t = p.terms[i];
    var hay = searchRecipeHay(r, 'all').toLowerCase();
    var hit = hay.indexOf(t.val) > -1;
    if (t.neg ? hit : !hit) return false;
  }
  for (var j = 0; j < p.ops.length; j++) {
    if (!searchMatchOp(r, p.ops[j])) return false;
  }
  for (var k = 0; k < p.flags.length; k++) {
    if (!searchMatchFlag(r, p.flags[k])) return false;
  }
  return true;
}

/* Explain a query back to the user so the syntax is discoverable. */
function searchDescribe(q) {
  var query = String(q || '').trim();
  if (!query) return '';
  if (!searchHasOperators(query)) return '';
  var p = searchParse(query);
  var bits = [];
  p.ops.forEach(function (o) {
    var sym = o.cmp || '=';
    if (o.kind === 'under' || o.kind === 'over') bits.push((o.neg ? 'not ' : '') + o.kind + ' ' + (o.n) + ' min');
    else if (o.kind === 'serves') bits.push((o.neg ? 'not ' : '') + 'serves ' + sym + ' ' + o.n);
    else if (o.kind === 'rating') bits.push((o.neg ? 'not ' : '') + 'rating ' + sym + ' ' + o.n);
    else bits.push((o.neg ? 'not ' : '') + o.kind + ' contains "' + o.val + '"');
  });
  p.flags.forEach(function (f) { bits.push((f.neg ? 'not ' : '') + f.kind); });
  p.terms.forEach(function (t) { bits.push((t.neg ? 'not ' : '') + '"' + t.val + '"'); });
  var out = bits.length ? ('Matching: ' + bits.join(' AND ')) : '';
  if (p.errors.length) out += (out ? ' \u00b7 ' : '') + 'Ignored: ' + p.errors.join(', ');
  return out;
}

/* Live hint under the search box. */
function initSearchUI() {
  var q = document.getElementById('q');
  if (!q) return;
  var el = document.getElementById('searchHelp');
  if (!el) {
    el = document.createElement('div');
    el.id = 'searchHelp';
    el.className = 'small search-help';
    var grid = q.closest('.grid2') || q.parentNode;
    if (grid && grid.parentNode) grid.parentNode.insertBefore(el, grid.nextSibling);
    else q.parentNode.insertBefore(el, q.nextSibling);
  }

  function update() {
    var v = q.value;
    var d = searchDescribe(v);
    if (d) { el.innerHTML = esc(d); el.style.display = 'block'; return; }
    if (/[a-zA-Z]+:|"/.test(v)) { el.textContent = 'Try tag:vegan, cat:mains, ing:flour, under:30, serves:6, rating:>=4, fav, photo, cooked, -olive, "green beans"'; el.style.display = 'block'; return; }
    el.style.display = 'none';
  }

  q.addEventListener('input', update);
  q.addEventListener('keyup', update);
  update();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSearchUI);
else initSearchUI();