/* Recipe Box v3 - recipe content, cook mode, print/cookbook layer.
   Ingredient sections, per-ingredient notes and substitutes, target-serving
   scaling, and a printable cookbook / Save-as-PDF export. */

var _baseOpenViewV2 = openView;
var _baseOpenCookV2 = openCook;
var _baseToMarkdown = toMarkdown;

/* Rewrite one ingredient line with its quantity scaled, keeping note/sub. */
function rescaleIngLine(raw, factor) {
  if (!factor || Math.abs(factor - 1) < 0.0001) return raw;
  var x = splitIngExtra(raw);
  var p = parseQtyText(x.main);
  if (p.kind === 'raw') return raw;           // nothing numeric to scale
  var out = fmtIng(x.main, factor);
  if (x.note) out += ' | note: ' + x.note;
  if (x.sub) out += ' | sub: ' + x.sub;
  return out;
}

/* Turn the currently displayed target into the recipe's real base servings,
   rewriting ingredient quantities so nothing else changes. */
function setBaseServings(id, r) {
  if (!r) return;
  var base = parseServings(r.servings);
  var factor = getScale(id);
  var target = base ? base * factor : 0;

  if (!(base > 0)) { toast('Set the recipe servings first'); return; }
  if (!(target > 0) || Math.abs(factor - 1) < 0.001) {
    toast('The recipe is already at its base servings');
    return;
  }

  var shown = Math.round(target * 100) / 100;
  if (!confirm('Make ' + shown + ' servings the recipe\\u2019s base? Ingredient amounts will be rewritten (currently ' + base + ').')) return;

  var changed = 0;
  r.ing = (r.ing || []).map(function (line) {
    if (isIngHeader(line)) return line;
    var next = rescaleIngLine(line, factor);
    if (next !== line) changed++;
    return next;
  });

  r.servings = String(shown);
  r.updated = now();
  state.scale[id] = 1;
  save();
  render();
  logChange('servings', r.title, base + ' -> ' + shown + ' base servings (' + changed + ' ingredient lines rewritten)');
  openView(id);
  toast('Base set to ' + shown + ' servings (' + changed + ' ingredient lines rewritten)');
}

function ingredientSectionHtml(r, factor, cookMode) {
  var groups = ingGroups(r);
  if (!groups.length) return '<p><em>None</em></p>';
  var h = '<div class="ing-groups">';
  groups.forEach(function (g) {
    if (g.title) h += '<h4 class="ing-group-title">' + esc(g.title) + '</h4>';
    h += '<ul class="ing-list">' + g.items.map(function (item) {
      var x = splitIngExtra(item.text);
      var main = fmtIng(x.main, factor || 1);
      var extra = (x.note ? '<div class="ing-note">' + esc(x.note) + '</div>' : '') +
        (x.sub ? '<div class="ing-sub">Substitute: ' + esc(x.sub) + '</div>' : '');
      if (cookMode) {
        return '<li><label class="ck"><input type="checkbox" data-cstep="i' + item.idx + '"> ' + esc(main) + '</label>' + extra + '</li>';
      }
      return '<li>' + esc(main) + extra + '</li>';
    }).join('') + '</ul>';
  });
  return h + '</div>';
}

function cookedIngredientsHtml(r, factor) {
  var groups = ingGroups(r);
  if (!groups.length) return '<p><em>None</em></p>';
  var h = '';
  groups.forEach(function (g) {
    if (g.title) h += '<h4 class="ing-group-title">' + esc(g.title) + '</h4>';
    h += '<ul class="cook">' + g.items.map(function (item) {
      var x = splitIngExtra(item.text);
      return '<li><label class="ck"><input type="checkbox" data-cstep="i' + item.idx + '"> ' + esc(fmtIng(x.main, factor || 1)) + '</label>' +
        (x.note ? '<div class="ing-note">' + esc(x.note) + '</div>' : '') +
        (x.sub ? '<div class="ing-sub">Substitute: ' + esc(x.sub) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
  });
  return h;
}

function enhanceView(id) {
  var r = (state.recipes || []).find(function (x) { return x.id === id; });
  var vb = document.getElementById('viewBody');
  if (!r || !vb) return;
  var hs = vb.querySelectorAll('h3');
  for (var i = 0; i < hs.length; i++) {
    if (String(hs[i].textContent || '').trim().toLowerCase() === 'ingredients') {
      var ul = hs[i].nextElementSibling;
      var html = ingredientSectionHtml(r, getScale(id), false);
      if (ul && ul.tagName === 'UL') ul.outerHTML = html;
      else hs[i].insertAdjacentHTML('afterend', html);
      break;
    }
  }
  var tb = vb.querySelector('.toolbar');
  if (tb && !vb.querySelector('#vServings')) {
    var base = parseServings(r.servings);
    var target = base ? (base * getScale(id)) : 0;
    var input = '<label class="ck" style="margin-left:4px">Target servings <input id="vServings" type="number" min="1" step="1" style="width:76px" value="' + (target ? Math.round(target * 100) / 100 : '') + '"></label>';
    tb.insertAdjacentHTML('afterbegin', input);
    var vs = document.getElementById('vServings');
    if (vs) vs.onchange = function () {
      var b = parseServings(r.servings);
      var t = parseFloat(this.value);
      if (!(b > 0) || !(t > 0)) { toast('Set the recipe servings first'); return; }
      state.scale[id] = t / b;
      openView(id);
    };
    // Make the current target the recipe's permanent base, rewriting the
    // ingredient quantities rather than just rescaling the display.
    if (tb && !vb.querySelector('#vSetBase')) {
      tb.insertAdjacentHTML('afterbegin', '<button id="vSetBase" title="Store the current target as this recipe\'s servings and rewrite ingredient amounts">Set as base</button>');
      var sb = document.getElementById('vSetBase');
      if (sb) sb.onclick = function () { setBaseServings(id, r); };
    }
  }
  if (tb && !vb.querySelector('#vPrint')) tb.insertAdjacentHTML('beforeend', '<button id="vPrint">Print</button>');
  var del = document.getElementById('vDel');
  if (del) del.onclick = function () {
    if (typeof deleteRecipeSoft === 'function') deleteRecipeSoft(r);
    else {
      state.trash.unshift(JSON.parse(JSON.stringify(r)));
      state.recipes = state.recipes.filter(function (x) { return x.id !== id; });
      save(); render();
      try { document.getElementById('dView').close(); } catch (e) {}
    }
  };
  var pr = document.getElementById('vPrint');
  if (pr) pr.onclick = function () { printRecipe(r, getScale(id)); };
  var ps = document.getElementById('photoStrip');
  if (ps) ps.onclick = function (e) {
    var b = e.target.closest('button[data-phdel]');
    if (!b) return;
    var idx = +b.dataset.phdel;
    if (!r.photos[idx]) return;
    if (!confirm('Remove this photo?')) return;
    var photo = r.photos[idx];
    r.photos.splice(idx, 1);
    r.updated = now();
    if (photo && photo.id && typeof photoDelete === 'function') photoDelete(photo.id);
    save();
    openView(id);
    toast('Photo removed');
  };
}

openView = function (id) {
  var r = (state.recipes || []).find(function (x) { return x.id === id; });
  if (!r) return _baseOpenViewV2(id);
  return hydrateRecipePhotos(r).then(function () {
    _baseOpenViewV2(id);
    enhanceView(id);
  }).catch(function () {
    _baseOpenViewV2(id);
    enhanceView(id);
  });
};

openCook = function (r, factor) {
  factor = factor || (r ? getScale(r.id) : 1);
  if (!r) return;
  var body = '<h2 style="margin-top:0">' + esc(r.title) + '</h2><p class="small">' +
    esc([r.servings, r.time].filter(Boolean).join(' \u00b7 ')) + ' \u00b7 progress is saved on this device</p>' +
    '<div class="row" style="justify-content:flex-start;margin:6px 0"><button id="cookWake">Keep screen awake</button><button id="cookDone">Mark cooked</button></div>' +
    '<p class="small" id="cookProgInfo"></p><h3>Ingredients</h3>' + cookedIngredientsHtml(r, factor) +
    '<h3>Steps</h3><ol class="cook">' + (r.steps || []).map(function (st, i) {
      return '<li><label class="ck"><input type="checkbox" data-cstep="s' + i + '"> <strong>' + (i + 1) + '.</strong> ' + esc(st) + '</label>' + timerHtml(st) + '</li>';
    }).join('') + '</ol><div class="row"><button id="cookReset">Reset progress</button><button class="primary" id="cookClose">Close</button></div>';
  document.getElementById('cookBody').innerHTML = body;
  var prog = loadCookProgress(r.id);
  document.getElementById('cookBody').querySelectorAll('input[data-cstep]').forEach(function (cb) {
    if (prog[cb.dataset.cstep]) cb.checked = true;
  });
  document.getElementById('cookReset').onclick = function () { saveCookProgress(r.id, {}); openCook(r, factor); };
  document.getElementById('cookDone').onclick = function () {
    var note = askNote('Optional note for this cook (e.g. doubled sauce, 25 min):');
    if (note === null) return;
    markCooked(r, note);
  };
  document.getElementById('cookWake').onclick = function () {
    requestWakeLock().then(function () { toast('Screen wake lock requested (if supported)'); }).catch(function () { toast('Wake lock not available'); });
  };
  document.getElementById('cookClose').onclick = function () { releaseWakeLock(); document.getElementById('dCook').close(); };
  wireTimers(document.getElementById('cookBody'));
  wireCookProgress(document.getElementById('cookBody'), r.id);
  document.getElementById('dCook').showModal();
  requestWakeLock();
};

toMarkdown = function (r, factor) {
  var out = '# ' + r.title + '\n\n';
  if (r.servings || r.time) out += [r.servings, r.time].filter(Boolean).join(' \u00b7 ') + '\n\n';
  out += '## Ingredients\n';
  ingGroups(r).forEach(function (g) {
    if (g.title) out += '\n### ' + g.title + '\n';
    g.items.forEach(function (item) {
      var x = splitIngExtra(item.text);
      out += '- ' + fmtIng(x.main, factor || 1) + (x.note ? (' \u2014 ' + x.note) : '') + (x.sub ? (' (sub: ' + x.sub + ')') : '') + '\n';
    });
  });
  out += '\n## Steps\n' + (r.steps || []).map(function (s, n) { return (n + 1) + '. ' + s; }).join('\n');
  if (r.equip && r.equip.length) out += '\n\n## Equipment\n' + r.equip.map(function (i) { return '- ' + i; }).join('\n');
  if (r.nutrition) out += '\n\n## Nutrition (estimate)\n' + r.nutrition;
  if (r.notes) out += '\n\n## Notes\n' + r.notes;
  if (r.src) out += '\n\nSource: ' + r.src;
  return out;
};

/* ===== Printable recipe / cookbook ===== */
function recipePhotoSrc(r) {
  if (!r || !r.photos || !r.photos.length) return '';
  var p = r.photos[0];
  return photoUrl(p) || p.url || '';
}
function recipeBodyHtml(r, factor) {
  var meta = [r.servings, r.time, r.difficulty].filter(Boolean).join(' \u00b7 ');
  var h = '<h2 class="recipe-title">' + esc(r.title) + (r.fav ? ' \u2605' : '') + '</h2>';
  if (meta || r.rating) h += '<p class="meta">' + esc(meta) + (r.rating ? (' \u00b7 ' + r.rating + ' / 5') : '') + '</p>';
  if (r.tags && r.tags.length) h += '<p class="tags">' + r.tags.map(function (t) { return '#' + esc(t); }).join(' ') + '</p>';
  var img = recipePhotoSrc(r);
  if (img) h += '<img class="recipe-photo" src="' + esc(img) + '" alt="">';
  h += '<div class="recipe-cols"><div><h3>Ingredients</h3>' + ingredientSectionHtml(r, factor, false) + '</div><div><h3>Steps</h3><ol>' +
    (r.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div></div>';
  if (r.equip && r.equip.length) h += '<h3>Equipment</h3><ul>' + r.equip.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  if (r.nutrition) h += '<h3>Nutrition (estimate)</h3><p>' + esc(r.nutrition) + '</p>';
  if (r.notes) h += '<h3>Notes</h3><p>' + esc(r.notes).replace(/\n/g, '<br>') + '</p>';
  if (r.src) h += '<p class="src">Source: ' + esc(r.src) + '</p>';
  return h;
}
function printRecipe(r, factor) {
  if (!r) return;
  hydrateRecipePhotos(r).then(function () {
    var html = '<!doctype html><meta charset="utf-8"><title>' + esc(r.title) + '</title><style>' +
      'body{font:16px/1.55 Georgia,serif;max-width:820px;margin:24px auto;padding:0 20px;color:#111}' +
      'h1,h2,h3,h4{font-family:system-ui,sans-serif}.recipe-title{margin:0 0 4px}.meta,.tags,.src{color:#666;font-size:.9rem}' +
      '.recipe-photo{max-width:100%;max-height:340px;object-fit:cover;border-radius:10px;margin:10px 0}' +
      '.recipe-cols{display:grid;grid-template-columns:1fr 1.4fr;gap:26px}.recipe-cols ul,.recipe-cols ol{padding-left:20px}' +
      'h3{font-size:1rem;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ccc;margin:18px 0 6px}' +
      '.ing-group-title{font-size:.9rem;margin:12px 0 2px;color:#333}.ing-note{font-size:.85rem;color:#666}.ing-sub{font-size:.85rem;color:#7a5b12}' +
      '.ing-list{padding-left:20px;margin:4px 0}@media print{body{margin:0}.no-print{display:none}}</style>' +
      '<button class="no-print" onclick="window.print()" style="float:right">Print / Save as PDF</button>' + recipeBodyHtml(r, factor || 1);
    var w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print this recipe'); return; }
    w.document.write(html);
    w.document.close();
  });
}

function selectedForExport() {
  if (state.bulkMode) {
    var b = (typeof bulkIds === 'function' ? bulkIds() : []);
    var selB = state.recipes.filter(function (r) { return b.indexOf(r.id) > -1; });
    if (selB.length) return { list: selB, label: 'selected' };
  }
  var e = Object.keys(state.exportSel || {}).filter(function (id) { return state.exportSel[id]; });
  var selE = state.recipes.filter(function (r) { return e.indexOf(r.id) > -1; });
  if (selE.length) return { list: selE, label: 'selected' };
  return { list: state.recipes.slice(), label: 'all' };
}
async function exportCookbook() {
  var picked = selectedForExport();
  var list = picked.list;
  if (!list.length) { toast('No recipes to export'); return; }
  toast('Preparing cookbook (' + list.length + ' recipes)...');
  await ensureAllPhotos();
  for (var i = 0; i < list.length; i++) await hydrateRecipePhotos(list[i]);
  var today = new Date().toLocaleDateString();
  var html = '<!doctype html><meta charset="utf-8"><title>Recipe Box Cookbook</title><style>' +
    '@page{margin:18mm}body{font:16px/1.55 Georgia,serif;max-width:900px;margin:24px auto;padding:0 20px;color:#111}' +
    'h1,h2,h3,h4{font-family:system-ui,sans-serif}h1.cover-title{font-size:2.6rem;margin:16vh 0 4px}' +
    '.cover{text-align:center;page-break-after:always;min-height:80vh}.cover p{color:#555}' +
    '.toc{page-break-after:always}.toc h2{font-size:1.4rem}.toc ol{line-height:1.9}.toc a{color:#145a5a;text-decoration:none}' +
    '.recipe{page-break-before:always}.recipe-title{margin:0 0 4px}.meta,.tags,.src{color:#666;font-size:.9rem}' +
    '.recipe-photo{max-width:100%;max-height:360px;object-fit:cover;border-radius:10px;margin:10px 0}' +
    '.recipe-cols{display:grid;grid-template-columns:1fr 1.4fr;gap:26px}.recipe-cols ul,.recipe-cols ol{padding-left:20px}' +
    'h3{font-size:1rem;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ccc;margin:18px 0 6px}' +
    '.ing-group-title{font-size:.9rem;margin:12px 0 2px;color:#333}.ing-note{font-size:.85rem;color:#666}.ing-sub{font-size:.85rem;color:#7a5b12}' +
    '.ing-list{padding-left:20px;margin:4px 0}.no-print{position:fixed;right:16px;top:16px;padding:8px 14px;font:14px system-ui;border:1px solid #999;border-radius:8px;background:#fff;cursor:pointer}' +
    '@media print{.no-print{display:none}body{margin:0}}' +
    '@media(max-width:700px){.recipe-cols{grid-template-columns:1fr}}' +
    '</style><button class="no-print" onclick="window.print()">Print / Save as PDF</button>' +
    '<div class="cover"><h1 class="cover-title">Recipe Box</h1><p>' + esc(list.length) + ' recipes \u00b7 ' + esc(today) + '</p><p>' + esc(picked.label === 'selected' ? 'Selected recipes' : 'Complete collection') + '</p></div>' +
    '<div class="toc"><h2>Contents</h2><ol>' + list.map(function (r, i) {
      return '<li><a href="#recipe-' + i + '">' + esc(r.title) + '</a></li>';
    }).join('') + '</ol></div>';
  list.forEach(function (r, i) {
    html += '<section class="recipe" id="recipe-' + i + '">' + recipeBodyHtml(r, 1) + '</section>';
  });
  var w = window.open('', '_blank');
  if (!w) {
    var blob = new Blob([html], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'recipe-box-cookbook.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Pop-up blocked; downloaded cookbook HTML instead');
    return;
  }
  w.document.write(html);
  w.document.close();
  toast('Cookbook opened - use Print / Save as PDF');
}

function initContentUI() {
  var b = document.getElementById('btnCookbook');
  if (b) b.onclick = exportCookbook;
}
