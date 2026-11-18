/* Recipe Box v3 - sync hardening layer.
   Loaded after features-store.js / features-plan.js / features-content.js.
   Adds recipe tombstones, per-recipe conflict picks, device metadata and the
   single featuresInit() boot hook for the v3 feature layers. */

var _syncBaseStablePayload = stablePayload;
var _syncBaseMergePayloads = mergePayloads;
var _syncBaseOpenSyncConflict = openSyncConflict;
var _syncBasePushSync = pushSync;
var _syncBaseOpenHistory = openHistory;

var _syncPicks = {};

/* ===== Device metadata ===== */
function deviceStoreRead() {
  try {
    var d = JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}');
    if (d && d.id) return d;
  } catch (e) {}
  return null;
}
function deviceStoreWrite(d) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(d || {})); } catch (e) {}
}
function defaultDeviceName() {
  var p = String((navigator && navigator.platform) || '');
  if (/win/i.test(p)) return 'Windows browser';
  if (/mac/i.test(p)) return 'Mac browser';
  if (/iphone|ipad|ipod/i.test(p)) return 'iOS device';
  if (/android/i.test(p)) return 'Android device';
  if (/linux/i.test(p)) return 'Linux browser';
  return 'This browser';
}
function deviceRecord() {
  var d = deviceStoreRead();
  if (!d) {
    d = {
      id: 'dev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: defaultDeviceName(),
      created: now()
    };
    deviceStoreWrite(d);
  }
  if (!d.name) d.name = defaultDeviceName();
  return d;
}
function deviceMeta() {
  var d = deviceRecord();
  return {
    id: d.id,
    name: d.name,
    platform: String((navigator && navigator.platform) || ''),
    app: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '3.0.0'),
    lastSeen: now()
  };
}
function setDeviceName(name) {
  var d = deviceRecord();
  d.name = String(name || '').trim() || defaultDeviceName();
  deviceStoreWrite(d);
  return d.name;
}

/* ===== Tombstones =====
   A tombstone records a recipe id that was deleted so a later merge cannot
   resurrect it from another device. A recipe edited after the deletion wins. */
function tombstoneMap(list) {
  var map = {};
  (list || []).forEach(function (t) {
    if (!t || !t.id) return;
    var cur = map[t.id];
    if (!cur || (t.when || 0) >= (cur.when || 0)) {
      map[t.id] = { id: t.id, title: t.title || (cur && cur.title) || '', when: t.when || (cur && cur.when) || 0 };
    }
  });
  return map;
}
function sortedTombstones(list) {
  var map = tombstoneMap(list);
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return (a.when || 0) - (b.when || 0); })
    .slice(-500);
}
function markTombstone(r) {
  if (!r || !r.id) return;
  state.tombstones = Array.isArray(state.tombstones) ? state.tombstones : [];
  var existing = state.tombstones.filter(function (t) { return t && t.id === r.id; });
  var when = now();
  existing.forEach(function (t) { if ((t.when || 0) > when) when = t.when; });
  state.tombstones = state.tombstones.filter(function (t) { return !t || t.id !== r.id; });
  state.tombstones.push({ id: r.id, title: r.title || '', when: when });
  state.tombstones = sortedTombstones(state.tombstones);
}
function removeTombstone(id) {
  if (!id) return;
  state.tombstones = (state.tombstones || []).filter(function (t) { return t && t.id !== id; });
}
function filterRecipesByTombstones(list, tombs) {
  var map = tombstoneMap(tombs);
  var out = [];
  (list || []).forEach(function (r) {
    if (!r || !r.id) return;
    var t = map[r.id];
    if (!t) { out.push(r); return; }
    if ((r.updated || 0) >= (t.when || 0)) {
      // Recipe was re-created/edited after the deletion, so it wins.
      out.push(r);
      delete map[r.id];
    }
  });
  return out;
}
function filterByTombstones() {
  state.tombstones = sortedTombstones(state.tombstones || []);
  var before = (state.recipes || []).length;
  state.recipes = filterRecipesByTombstones(state.recipes, state.tombstones);
  return before !== state.recipes.length;
}

function deleteRecipeSoft(r, opts) {
  opts = opts || {};
  if (!r || !r.id) return false;
  var copy = JSON.parse(JSON.stringify(r));
  copy.deletedAt = now();
  state.trash = Array.isArray(state.trash) ? state.trash : [];
  state.trash = state.trash.filter(function (x) { return !x || x.id !== r.id; });
  state.trash.unshift(copy);
  state.recipes = (state.recipes || []).filter(function (x) { return x.id !== r.id; });
  state.plan = (state.plan || []).filter(function (id) { return id !== r.id; });
  state.selIds = state.selIds || {};
  delete state.selIds[r.id];
  if (state.exportSel) delete state.exportSel[r.id];
  markTombstone(r);
  logChange('delete', r.title, 'Moved to trash');
  if (!opts.noSave) save();
  // Do not leave the reader dialog open on a recipe that no longer exists.
  var view = document.getElementById('dView');
  if (view && view.open) { try { view.close(); } catch (e) {} }
  if (!opts.noRender) render();
  if (!opts.silent) toast('Moved "' + r.title + '" to trash');
  return true;
}

/* ===== Stable payload / merge ===== */
stablePayload = function (p) {
  var o = {
    recipes: (p && p.recipes) || [],
    cats: (p && p.cats) || [],
    trash: (p && p.trash) || [],
    history: (p && p.history) || [],
    plan: (p && p.plan) || [],
    shopDone: (p && p.shopDone) || { '__items__': [] },
    savedViews: (p && p.savedViews) || [],
    calendar: (p && p.calendar) || [],
    pantry: (p && p.pantry) || [],
    cookProgress: (p && p.cookProgress) || {},
    changelog: (p && p.changelog) || [],
    tombstones: sortedTombstones((p && p.tombstones) || []),
    shopBudget: (p && p.shopBudget) || '',
    calWeekStart: (p && p.calWeekStart) || ''
  };
  return JSON.stringify(o);
};

function mergeTombstones(a, b) {
  return sortedTombstones((a || []).concat(b || []));
}

function applySyncPicks(merged, local, remote) {
  var picks = _syncPicks || {};
  var lmap = {}, rmap = {};
  (local.recipes || []).forEach(function (r) { if (r && r.id) lmap[r.id] = r; });
  (remote.recipes || []).forEach(function (r) { if (r && r.id) rmap[r.id] = r; });
  var changed = false;
  merged.recipes = (merged.recipes || []).map(function (r) {
    if (!r || !r.id) return r;
    var pick = picks[r.id];
    if (pick === 'local' && lmap[r.id]) { changed = true; return JSON.parse(JSON.stringify(lmap[r.id])); }
    if (pick === 'remote' && rmap[r.id]) { changed = true; return JSON.parse(JSON.stringify(rmap[r.id])); }
    return r;
  });
  if (changed) {
    var seen = {};
    merged.recipes = merged.recipes.filter(function (r) {
      if (!r || !r.id) return false;
      if (seen[r.id]) return false;
      seen[r.id] = 1;
      return true;
    });
  }
  return merged;
}

mergePayloads = function (local, remote) {
  var merged = _syncBaseMergePayloads(local, remote);
  merged = applySyncPicks(merged, local || {}, remote || {});
  merged.tombstones = mergeTombstones(local && local.tombstones, remote && remote.tombstones);
  merged.recipes = filterRecipesByTombstones(merged.recipes, merged.tombstones);
  merged.shopBudget = (local && local.shopBudget) || (remote && remote.shopBudget) || '';
  merged.calWeekStart = (local && local.calWeekStart) || (remote && remote.calWeekStart) || '';
  return merged;
};

/* ===== Conflict dialog with per-recipe picks ===== */
function stableRecipe(r) {
  try { return JSON.stringify(r || {}); } catch (e) { return String(r); }
}
function recipeConflicts(local, remote) {
  var lmap = {}, out = [];
  (local && local.recipes || []).forEach(function (r) { if (r && r.id) lmap[r.id] = r; });
  (remote && remote.recipes || []).forEach(function (r) {
    if (!r || !r.id) return;
    var l = lmap[r.id];
    if (l && stableRecipe(l) !== stableRecipe(r)) out.push({ id: r.id, local: l, remote: r });
  });
  out.sort(function (a, b) {
    return String((a.remote && a.remote.title) || '').localeCompare(String((b.remote && b.remote.title) || ''));
  });
  return out;
}

openSyncConflict = function (remote) {
  return new Promise(function (resolve) {
    var dlg = document.getElementById('dSyncConflict');
    var box = document.getElementById('syncCompare');
    var warn = document.getElementById('syncWarn');
    if (!dlg || !box) { resolve('cancel'); return; }
    _syncPicks = {};
    var local = payload();
    var merged = mergePayloads(local, remote);
    function row(label, l, r, m) {
      return '<div class="itemrow"><strong style="flex:1">' + esc(label) + '</strong>' +
        '<span class="small">local ' + l + ' / server ' + r + ' / merged ' + m + '</span></div>';
    }
    var shopL = ((local.shopDone && local.shopDone['__items__']) || []).length;
    var shopR = ((remote.shopDone && remote.shopDone['__items__']) || []).length;
    var h = row('Recipes', (local.recipes || []).length, (remote.recipes || []).length, merged.recipes.length) +
      row('Categories', (local.cats || []).length, (remote.cats || []).length, merged.cats.length) +
      row('Planned meals', (local.plan || []).length, (remote.plan || []).length, merged.plan.length) +
      row('Calendar entries', (local.calendar || []).length, (remote.calendar || []).length, merged.calendar.length) +
      row('Pantry items', (local.pantry || []).length, (remote.pantry || []).length, merged.pantry.length) +
      row('Shopping items', shopL, shopR, merged.shopDone['__items__'].length) +
      row('Saved views', (local.savedViews || []).length, (remote.savedViews || []).length, merged.savedViews.length) +
      row('Tombstones', (local.tombstones || []).length, (remote.tombstones || []).length, (merged.tombstones || []).length) +
      row('Trash', (local.trash || []).length, (remote.trash || []).length, merged.trash.length);

    var ld = local.device || {};
    var rd = remote.device || {};
    h += '<div class="small" style="margin-top:8px"><strong>Devices</strong><br>This browser: ' +
      esc(ld.name || deviceMeta().name || 'unknown') + ' (' + esc(ld.id || '') + ')<br>Server copy: ' +
      esc(rd.name || 'unknown') + ' (' + esc(rd.id || '') + ')' +
      (rd.lastSeen ? ('<br>Server last written ' + esc(new Date(rd.lastSeen).toLocaleString())) : '') + '</div>';

    var conflicts = recipeConflicts(local, remote);
    if (conflicts.length) {
      h += '<div style="margin-top:10px"><strong>Changed in both (' + conflicts.length + ')</strong>' +
        '<div class="small">Pick a side per recipe, or keep the newest edit.</div>' +
        '<div class="syncconflicts">' + conflicts.map(function (c) {
          var lt = (c.local && c.local.updated) || 0;
          var rt = (c.remote && c.remote.updated) || 0;
          var newest = rt >= lt ? 'server' : 'local';
          return '<div class="itemrow"><div style="flex:1;min-width:120px"><strong>' +
            esc((c.remote && c.remote.title) || (c.local && c.local.title) || 'Untitled') + '</strong>' +
            '<div class="small">local ' + (lt ? new Date(lt).toLocaleString() : 'unknown') +
            ' / server ' + (rt ? new Date(rt).toLocaleString() : 'unknown') + '</div></div>' +
            '<select data-pick="' + esc(c.id) + '" aria-label="Keep which version of ' +
            esc((c.remote && c.remote.title) || 'recipe') + '">' +
            '<option value="newest">Newest (' + newest + ')</option><option value="local">Local</option><option value="remote">Server</option></select></div>';
        }).join('') + '</div></div>';
    }

    box.innerHTML = h;
    if (warn) {
      warn.style.display = 'block';
      warn.className = 'status';
      warn.textContent = 'Nothing changes until you choose an option below.';
    }

    function collectPicks() {
      var picks = {};
      box.querySelectorAll('select[data-pick]').forEach(function (sel) {
        if (sel.value === 'local' || sel.value === 'remote') picks[sel.dataset.pick] = sel.value;
      });
      return picks;
    }
    function cleanup() {
      ['scCancel', 'scLocal', 'scRemote', 'scMerge'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.onclick = null;
      });
    }
    function done(c) {
      _syncPicks = c === 'merge' ? collectPicks() : {};
      cleanup();
      try { dlg.close(); } catch (e) {}
      resolve(c);
    }
    var bc = document.getElementById('scCancel');
    if (bc) bc.onclick = function () { done('cancel'); };
    var bl = document.getElementById('scLocal');
    if (bl) bl.onclick = function () { done('local'); };
    var br = document.getElementById('scRemote');
    if (br) br.onclick = function () { done('remote'); };
    var bm = document.getElementById('scMerge');
    if (bm) bm.onclick = function () { done('merge'); };
    try { dlg.showModal(); } catch (e) { resolve('cancel'); }
  });
};

/* ===== Push wrapper: prune old tombstones after a successful push ===== */
pushSync = async function (manual) {
  var ok = await _syncBasePushSync(manual);
  if (ok) {
    var cutoff = now() - 180 * 86400000;
    var before = (state.tombstones || []).length;
    state.tombstones = (state.tombstones || []).filter(function (t) { return t && (t.when || 0) >= cutoff; });
    if (state.tombstones.length !== before) saveLocalOnly();
  }
  return ok;
};

/* ===== History: tombstone panel + restore clears tombstone ===== */
function renderTombstones() {
  var dlg = document.getElementById('dHistory');
  if (!dlg) return;
  var panel = document.getElementById('tombPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'tombPanel';
    panel.className = 'panel';
    var hist = document.getElementById('histList');
    var target = hist && hist.parentNode ? hist.parentNode : null;
    if (target && target.parentNode) target.parentNode.insertBefore(panel, target.nextSibling);
    else dlg.appendChild(panel);
  }
  var list = sortedTombstones(state.tombstones || []).slice().reverse();
  panel.innerHTML = '<strong>Sync tombstones (' + list.length + ')</strong>' +
    '<div class="small">Deleted recipes are remembered so other devices cannot bring them back. Removing a tombstone allows a later sync to restore that recipe.</div>' +
    '<div class="listbox">' + (list.length ? list.map(function (t) {
      return '<div class="itemrow"><div style="flex:1"><strong>' + esc(t.title || t.id) + '</strong>' +
        '<div class="small">deleted ' + esc(t.when ? new Date(t.when).toLocaleString() : 'unknown') + '</div></div>' +
        '<button data-tombdel="' + esc(t.id) + '">Allow restore</button></div>';
    }).join('') : '<div class="small">No tombstones.</div>') + '</div>';
  panel.onclick = function (e) {
    var b = e.target.closest('button[data-tombdel]');
    if (!b) return;
    removeTombstone(b.dataset.tombdel);
    saveLocalOnly();
    renderTombstones();
    toast('Tombstone removed');
  };
}

openHistory = function () {
  _syncBaseOpenHistory();
  renderTombstones();
  var tl = document.getElementById('trashList');
  if (tl) {
    var prev = tl.onclick;
    tl.onclick = function (e) {
      var b = e.target.closest('button[data-undo]');
      if (b) {
        var r = (state.trash || [])[+b.dataset.undo];
        if (r && r.id) removeTombstone(r.id);
      }
      if (prev) return prev.call(this, e);
    };
  }
};

/* ===== Sync dialog extras: device name + server info ===== */
function renderSyncExtras() {
  var nameIn = document.getElementById('syncDevice');
  var d = deviceRecord();
  if (nameIn && document.activeElement !== nameIn) nameIn.value = d.name || '';
  var info = document.getElementById('syncServerInfo');
  if (!info) return;
  var c = syncCfg();
  info.innerHTML = '<strong>This device:</strong> ' + esc(d.name || '') + ' (' + esc(d.id) + ')' +
    '<br><strong>Sync endpoint:</strong> ' + esc(c.url || '(not set)') +
    '<br><strong>Auto-sync:</strong> ' + (c.auto ? 'on' : 'off') +
    '<br><strong>Encryption:</strong> ' + (c.passphrase ? 'on' : 'off') +
    '<br><span class="small">Device name and id travel with sync payloads so conflicts show which copy came from where.</span>' +
    '<div id="syncServerLive" class="small" style="margin-top:6px">Server: checking…</div>';
  refreshServerInfo();
}
async function refreshServerInfo() {
  var live = document.getElementById('syncServerLive');
  if (!live || typeof syncRaw !== 'function') return;
  var base = String(syncCfg().url || '').replace(/\/+$/, '');
  if (!base) { live.textContent = 'Server: no endpoint set.'; return; }
  try {
    var d = await syncRaw(base + '/info');
    if (!d || !d.ok) throw new Error('no info');
    live.innerHTML = '<strong>Server status:</strong> reachable' +
      (d.syncedAt ? (' · last write ' + esc(new Date(d.syncedAt).toLocaleString())) : '') +
      (d.device && d.device.name ? (' · from ' + esc(d.device.name)) : '') +
      (d.encrypted ? ' · encrypted payload' : ' · plain JSON') +
      (d.counts ? (' · ' + (d.counts.recipes || 0) + ' recipes, ' + (d.counts.versions || 0) + ' versions') : '');
  } catch (e) {
    live.textContent = 'Server: offline or unreachable (' + (e.message || e) + ').';
  }
}
function initSyncExtras() {
  var bs = document.getElementById('btnSync');
  if (bs) {
    var prev = bs.onclick;
    bs.onclick = function (e) {
      if (prev) prev.call(this, e);
      renderSyncExtras();
    };
  }
  var nameIn = document.getElementById('syncDevice');
  if (nameIn) {
    nameIn.onchange = function () {
      var name = setDeviceName(this.value);
      saveSyncCfg({ deviceName: name });
      renderSyncExtras();
      toast('Device name saved');
    };
  }
  var info = document.getElementById('syncServerInfo');
  if (info) renderSyncExtras();
}

/* ===== Bulk delete override ===== */
function initBulkDelete() {
  var b = document.getElementById('bulkDelete');
  if (!b || typeof bulkIds !== 'function') return;
  b.onclick = function () {
    var ids = bulkIds();
    if (!ids.length) { toast('Select recipes first'); return; }
    if (!confirm('Move ' + ids.length + ' recipe(s) to trash?')) return;
    var n = 0;
    ids.forEach(function (id) {
      var r = (state.recipes || []).find(function (x) { return x.id === id; });
      if (r) { deleteRecipeSoft(r, { noSave: true, noRender: true, silent: true }); n++; }
    });
    if (!state.bulkMode && typeof exitBulk === 'function') { try { exitBulk(); } catch (e) {} }
    state.bulkMode = false;
    state.selIds = {};
    save();
    render();
    toast('Moved ' + n + ' recipe(s) to trash');
  };
}

/* ===== Boot ===== */
function featuresInit() {
  state.tombstones = Array.isArray(state.tombstones) ? state.tombstones : [];
  loadExtras();
  if (filterByTombstones()) { saveLocalOnly(); render(); }
  initStoreUI();
  initPlanUI();
  initContentUI();
  initSyncExtras();
  initBulkDelete();
  // app.js binds btnHistory to the openHistory it saw at load time; rebind so
  // the tombstone-aware wrapper is the one that actually runs.
  var historyBtn = document.getElementById('btnHistory');
  if (historyBtn) historyBtn.onclick = function () { openHistory(); };
  initCameraUI();
  migratePhotos().catch(function () {});
  maybeAutoBackup().catch(function () {});
  renderBackups();
  updateStorageInfo();
  try { renderCalendar(); } catch (e) {}
  try { renderShopUI(); } catch (e) {}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', featuresInit);
else featuresInit();
