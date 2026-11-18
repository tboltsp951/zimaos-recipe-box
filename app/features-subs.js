/* Recipe Box v3 - AI substitution advisor.
   Suggests swaps for a missing ingredient, aware of what is already in the
   pantry, and can write the chosen swap into the recipe's `sub:` field so it
   shows in the recipe view and is stripped from the shopping list.
   Loaded last, after features-recs.js. */

var _subsBaseOpenView = openView;

var SUB_SYS_PROMPT =
  'You are a practical cooking assistant. Suggest real, workable substitutions for one ingredient ' +
  'in a specific recipe. Reply with ONLY JSON, no prose, in this exact shape:\n' +
  '{"ingredient":"<the ingredient as written>","options":[{"name":"<what to use instead>",' +
  '"ratio":"<how much to use, e.g. 3/4 as much, or 1:1>",' +
  '"note":"<one short sentence: what it does to the dish>",' +
  '"flags":["contains dairy"],' +
  '"pantry":false}]}\n\n' +
  'Rules:\n' +
  '- Give 2 to 4 options, best first. Prefer things a normal kitchen already has.\n' +
  '- The ratio must be a usable instruction, not a vague "adjust to taste".\n' +
  '- Use flags for real consequences: "contains dairy", "contains gluten", "contains nuts", ' +
  '"changes texture", "changes flavour", "needs cooking first", "not for baking".\n' +
  '- Set pantry to true only for an option that matches an item in the supplied pantry list.\n' +
  '- If no sensible substitution exists (e.g. it is the defining ingredient), return an empty options array.\n' +
  '- Never suggest something unsafe. Raw flour, raw egg and uncooked meat are not swaps for each other.';

function subEsc(s) { return esc(s == null ? '' : String(s)); }

function subPantryKeys() {
  var map = {};
  (state.pantry || []).forEach(function (p) {
    if (!p || !p.have) return;
    var k = pantryKey(p.name);
    if (k) map[k] = p.name;
    // also index single words so "buttermilk" matches "1 cup buttermilk"
    k.split(' ').forEach(function (w) { if (w && !map[w]) map[w] = p.name; });
  });
  return map;
}

function subHasInPantry(text, pantryMap) {
  var k = pantryKey(text);
  if (!k) return false;
  if (pantryMap[k]) return true;
  var words = k.split(' ');
  for (var i = 0; i < words.length; i++) {
    if (pantryMap[words[i]]) return true;
  }
  return false;
}

/* Rewrite one ingredient line with a new substitute, keeping any note intact. */
function subSetIngredientSub(rawText, subText) {
  var x = splitIngExtra(rawText);
  var out = x.main;
  if (x.note) out += ' | note: ' + x.note;
  if (subText) out += ' | sub: ' + subText;
  return out;
}

/* Ask the model for substitutions for a single ingredient line. */
async function subSuggestOne(r, rawText) {
  var x = splitIngExtra(rawText);
  var pantry = subPantryKeys();
  var pantryList = Object.keys(pantry).map(function (k) { return pantry[k]; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .slice(0, 60);

  var user =
    'Recipe: ' + (r.title || 'Untitled') + '\n' +
    'Other ingredients: ' + (r.ing || [])
      .filter(function (s) { return !isIngHeader(s) && s !== rawText; })
      .map(function (s) { return splitIngExtra(s).main; })
      .join('; ') + '\n' +
    (r.notes ? 'Recipe notes: ' + r.notes + '\n' : '') +
    'Ingredient to replace: ' + x.main + (x.note ? (' (' + x.note + ')') : '') + '\n' +
    (pantryList.length ? ('Already in this kitchen: ' + pantryList.join(', ') + '\n') : '') +
    'Suggest substitutions for the ingredient to replace.';

  var data = await aiRequest({
    model: (aiCfg().model || DEFMODEL),
    temperature: 0.3,
    messages: [
      { role: 'system', content: SUB_SYS_PROMPT },
      { role: 'user', content: user }
    ]
  });

  var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  var parsed = parseAiJson(content);
  var opts = (parsed && parsed.options) || [];
  return opts.filter(function (o) { return o && o.name; }).map(function (o) {
    return {
      name: String(o.name),
      ratio: String(o.ratio || ''),
      note: String(o.note || ''),
      flags: Array.isArray(o.flags) ? o.flags.map(String) : (o.flags ? [String(o.flags)] : []),
      pantry: !!o.pantry
    };
  });
}

/* ===== Dialog ===== */
function subOpenDialog(r) {
  return new Promise(function (resolve) {
    var pantryMap = subPantryKeys();
    var lastOptions = {};   // idx -> rendered option HTML, kept after applying
    var rows = (r.ing || []).map(function (text, idx) {
      return { text: text, idx: idx };
    }).filter(function (x) { return !isIngHeader(x.text); });

    var dlg = document.createElement('dialog');
    dlg.id = 'dSubs';
    dlg.className = 'subs-dialog';
    dlg.innerHTML =
      '<h2 style="margin-top:0">Ingredient substitutions</h2>' +
      '<p class="small">Pick an ingredient to see swaps you can make with what you have. ' +
      'Applying one stores it as the recipe\'s substitute.</p>' +
      (aiCfg().key
        ? ''
        : '<div class="status err" style="display:block">Add an OpenRouter API key in Settings to use AI substitutions.</div>' +
          '<p class="hint">Without a key you can still see which ingredients your pantry already covers.</p>') +
      '<div class="subs-list">' +
      rows.map(function (x) {
        var parts = splitIngExtra(x.text);
        var have = subHasInPantry(parts.main, pantryMap);
        return '<div class="subs-row" data-idx="' + x.idx + '">' +
          '<div class="subs-ing">' +
          '<span class="subs-name">' + subEsc(fmtIng(parts.main, 1)) + '</span>' +
          (have ? '<span class="badge subs-have">on hand</span>' : '<span class="badge subs-missing">to buy</span>') +
          (parts.sub ? '<div class="ing-sub">Substitute: ' + subEsc(parts.sub) + '</div>' : '') +
          '</div>' +
          '<button data-ss="' + x.idx + '" ' + (aiCfg().key ? '' : 'disabled') + '>Suggest</button>' +
          '<div class="subs-out" data-out="' + x.idx + '"></div>' +
          '</div>';
      }).join('') +
      '</div>' +
      '<div class="row" style="justify-content:flex-start;flex-wrap:wrap">' +
      (aiCfg().key ? '<button id="subsAll">Suggest for all</button>' : '') +
      '<button id="subsClose">Close</button></div>';

    document.body.appendChild(dlg);
    var statusEl = null;

    function setOut(idx, html) {
      var el = dlg.querySelector('[data-out="' + idx + '"]');
      if (el) el.innerHTML = html;
    }

    function applySub(idx, name, ratio) {
      var text = (r.ing || [])[idx];
      if (text == null) return;
      var label = name + (ratio ? (' (' + ratio + ')') : '');
      var wasHandled = !!splitIngExtra(text).sub;
      r.ing[idx] = subSetIngredientSub(text, label);
      r.updated = now();
      save();
      render();
      logChange('substitution', r.title, splitIngExtra(text).main + ' -> ' + name);
      setOut(idx, '<div class="subs-applied">Using <strong>' + subEsc(name) + '</strong>' +
        (ratio ? (' · ' + subEsc(ratio)) : '') + '</div>' +
        '<div class="small">Other options are kept below in case you change your mind.</div>' +
        lastOptions[idx]);
      toast('Substitute set: ' + name);
      // Refresh the open recipe view so the new substitute is visible at once.
      var v = document.getElementById('dView');
      if (v && v.open) { try { openView(r.id); } catch (e) {} }
      // Refresh the badge area of this row so the new sub shows.
      var row = dlg.querySelector('.subs-row[data-idx="' + idx + '"]');
      if (row) {
        var ing = row.querySelector('.subs-ing');
        var have = subHasInPantry(splitIngExtra(text).main, pantryMap);
        if (ing) {
          ing.innerHTML = '<span class="subs-name">' + subEsc(fmtIng(splitIngExtra(text).main, 1)) + '</span>' +
            (have ? '<span class="badge subs-have">on hand</span>' : '<span class="badge subs-missing">to buy</span>') +
            '<div class="ing-sub">Substitute: ' + subEsc(name) + '</div>';
        }
      }
    }

    async function runOne(idx, btn) {
      var text = (r.ing || [])[idx];
      if (text == null) return;
      // Ingredients that already have a stored substitute stay as-is unless the
      // user explicitly re-asks for that one row.
      var existing = splitIngExtra(text).sub;
      if (existing && !btn) {
        setOut(idx, '<div class="small subs-none">Already using: ' + subEsc(existing) + '</div>');
        return;
      }
      setOut(idx, '<span class="small">Asking…</span>');
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        var opts = await subSuggestOne(r, text);
        if (!opts.length) {
          setOut(idx, '<div class="small subs-none">No good substitute for this one - it may be the defining ingredient.</div>');
          return;
        }
        lastOptions[idx] = opts.map(function (o) {
          var have = o.pantry || subHasInPantry(o.name, pantryMap);
          return '<div class="subs-opt">' +
            '<div class="subs-opt-head"><strong>' + subEsc(o.name) + '</strong>' +
            (o.ratio ? '<span class="subs-ratio">' + subEsc(o.ratio) + '</span>' : '') +
            (have ? '<span class="badge subs-have">on hand</span>' : '') + '</div>' +
            (o.note ? '<div class="small">' + subEsc(o.note) + '</div>' : '') +
            (o.flags && o.flags.length ? '<div class="subs-flags">' + o.flags.map(function (f) { return '<span class="badge">' + subEsc(f) + '</span>'; }).join(' ') + '</div>' : '') +
            '<button data-apply="' + idx + '" data-name="' + subEsc(o.name) + '" data-ratio="' + subEsc(o.ratio) + '">Use this</button>' +
            '</div>';
        }).join('');
        setOut(idx, lastOptions[idx]);
      } catch (e) {
        setOut(idx, '<div class="small" style="color:var(--warn)">' + subEsc(e.message || e) + '</div>');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Suggest'; }
      }
    }

    dlg.addEventListener('click', function (e) {
      var apply = e.target.closest('button[data-apply]');
      if (apply) {
        applySub(parseInt(apply.dataset.apply, 10), apply.dataset.name, apply.dataset.ratio);
        return;
      }
      var s = e.target.closest('button[data-ss]');
      if (s) { runOne(parseInt(s.dataset.ss, 10), s); return; }
    });

    var allBtn = dlg.querySelector('#subsAll');
    if (allBtn) {
      allBtn.onclick = async function () {
        allBtn.disabled = true;
        var btns = Array.prototype.slice.call(dlg.querySelectorAll('button[data-ss]'));
        for (var i = 0; i < btns.length; i++) {
          var idx = parseInt(btns[i].dataset.ss, 10);
          // skip ingredients that already have a stored substitute
          if (splitIngExtra((r.ing || [])[idx]).sub) {
            setOut(idx, '<div class="small">Already has a substitute.</div>');
            continue;
          }
          allBtn.textContent = 'Asking ' + (i + 1) + '/' + btns.length + '…';
          await runOne(idx, null);
        }
        allBtn.disabled = false;
        allBtn.textContent = 'Suggest for all';
      };
    }

    var closeBtn = dlg.querySelector('#subsClose');
    if (closeBtn) closeBtn.onclick = function () { dlg.close(); };

    function done() {
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      resolve(true);
    }
    dlg.addEventListener('close', done);
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); dlg.close(); });

    try { dlg.showModal(); } catch (e) { done(); }
  });
}

async function openSubstitutions(id) {
  var r = (state.recipes || []).find(function (x) { return x.id === id; });
  if (!r) { toast('Recipe not found'); return; }
  if (!(r.ing || []).filter(function (s) { return !isIngHeader(s); }).length) {
    toast('This recipe has no ingredients to substitute');
    return;
  }
  await hydrateRecipePhotos(r).catch(function () {});
  await subOpenDialog(r);
}

/* Add a Substitutions button to the recipe view toolbar. */
function subEnhanceView(id) {
  var vb = document.getElementById('viewBody');
  if (!vb) return;
  var tb = vb.querySelector('.toolbar');
  if (!tb || vb.querySelector('#vSubs')) return;
  tb.insertAdjacentHTML('beforeend', '<button id="vSubs">Substitutions</button>');
  var b = document.getElementById('vSubs');
  if (b) b.onclick = function () { openSubstitutions(id); };
}

openView = function (id) {
  var out = _subsBaseOpenView(id);
  if (out && typeof out.then === 'function') {
    return out.then(function () { try { subEnhanceView(id); } catch (e) {} });
  }
  try { subEnhanceView(id); } catch (e) {}
  return out;
};

function initSubsUI() {
  // Wires the button for any recipe view already on screen.
  var vb = document.getElementById('viewBody');
  if (vb && vb.querySelector('#vDel')) {
    var title = vb.querySelector('h2');
    void title;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSubsUI);
else initSubsUI();