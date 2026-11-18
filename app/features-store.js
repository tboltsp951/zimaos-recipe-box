/* Recipe Box v3 - storage & safety layer.
   Loaded after app.js. Photos move to IndexedDB, rotating local backups,
   storage-quota reporting, and full-photo exports/backups. */

var APP_VERSION = '3.0.0';
var PHOTO_STORE = 'photos';
var BACKUP_STORE = 'backups';
var DEVICE_KEY = 'recipebox-device';

var _basePayload = payload;
var _baseApplyPayload = applyPayload;
var _baseSaveLocalOnly = saveLocalOnly;
var _baseSave = save;
var _patchedBackupReminder = backupReminder;
var _baseOpenShop = openShop;

var _photoCache = {};
var _photoPending = {};
var _backupTimer = null;
var _lastStorageEstimate = null;

/* ===== IndexedDB (v2 adds photo + backup stores) ===== */
function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(FH_DB, 2);
    r.onupgradeneeded = function () {
      var db = r.result;
      if (!db.objectStoreNames.contains('h')) db.createObjectStore('h');
      if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      if (!db.objectStoreNames.contains(BACKUP_STORE)) db.createObjectStore(BACKUP_STORE);
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
    r.onblocked = function () { rej(new Error('IndexedDB upgrade blocked by another tab')); };
  });
}
function idbStoreGet(store, key) {
  return new Promise(function (res, rej) {
    idbOpen().then(function (db) {
      var tx = db.transaction(store, 'readonly');
      var rq = tx.objectStore(store).get(key);
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    }).catch(rej);
  });
}
function idbStorePut(store, key, value) {
  return new Promise(function (res, rej) {
    idbOpen().then(function (db) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = function () { res(value); };
      tx.onerror = function () { rej(tx.error); };
    }).catch(rej);
  });
}
function idbStoreDel(store, key) {
  return new Promise(function (res, rej) {
    idbOpen().then(function (db) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = function () { res(true); };
      tx.onerror = function () { rej(tx.error); };
    }).catch(rej);
  });
}
function idbStoreAll(store) {
  return new Promise(function (res, rej) {
    idbOpen().then(function (db) {
      var tx = db.transaction(store, 'readonly');
      var rq = tx.objectStore(store).getAll();
      rq.onsuccess = function () { res(rq.result || []); };
      rq.onerror = function () { rej(rq.error); };
    }).catch(rej);
  });
}

/* ===== Photo records ===== */
function newPhotoId() {
  return 'ph' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function isDataUrl(u) { return /^data:image\//i.test(String(u || '')); }
function isRemotePhoto(u) { return /^https?:\/\//i.test(String(u || '')); }

function photoUrl(p) {
  if (!p) return '';
  if (p.url) return p.url;
  if (p.id && _photoCache[p.id]) return _photoCache[p.id];
  if (p.id && !_photoPending[p.id]) {
    _photoPending[p.id] = idbStoreGet(PHOTO_STORE, p.id).then(function (rec) {
      delete _photoPending[p.id];
      if (rec && rec.url) _photoCache[p.id] = rec.url;
      return _photoCache[p.id] || '';
    }).catch(function () { delete _photoPending[p.id]; return ''; });
  }
  return '';
}
async function photoSave(id, url, name, type, size) {
  var rec = { id: id, url: url, name: name || 'photo', type: type || 'image/jpeg', size: size || url.length, added: now() };
  await idbStorePut(PHOTO_STORE, id, rec);
  _photoCache[id] = url;
  return rec;
}
async function photoDelete(id) {
  if (!id) return;
  delete _photoCache[id];
  try { await idbStoreDel(PHOTO_STORE, id); } catch (e) {}
}
async function hydrateRecipePhotos(r) {
  if (!r || !Array.isArray(r.photos)) return;
  for (var i = 0; i < r.photos.length; i++) {
    var p = r.photos[i];
    if (!p || (!p.id && !p.url)) continue;
    if (!p.id) p.id = newPhotoId();
    if (p.url && isDataUrl(p.url)) {
      _photoCache[p.id] = p.url;
      continue;
    }
    if (!p.url && _photoCache[p.id]) { p.url = _photoCache[p.id]; continue; }
    if (!p.url && p.id && !_photoPending[p.id]) {
      var rec = null;
      try { rec = await idbStoreGet(PHOTO_STORE, p.id); } catch (e) {}
      if (rec && rec.url) { _photoCache[p.id] = rec.url; p.url = rec.url; }
    }
  }
}
async function ensureAllPhotos() {
  var list = (state.recipes || []).concat(state.trash || []);
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !Array.isArray(r.photos)) continue;
    for (var j = 0; j < r.photos.length; j++) {
      var p = r.photos[j];
      if (!p) continue;
      if (!p.id) p.id = newPhotoId();
      if (p.url) { _photoCache[p.id] = p.url; continue; }
      if (_photoCache[p.id]) continue;
      try {
        var rec = await idbStoreGet(PHOTO_STORE, p.id);
        if (rec && rec.url) _photoCache[p.id] = rec.url;
      } catch (e) {}
    }
  }
}
async function migratePhotos() {
  var changed = false;
  var list = (state.recipes || []).concat(state.trash || []);
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !Array.isArray(r.photos)) continue;
    for (var j = 0; j < r.photos.length; j++) {
      var p = r.photos[j];
      if (!p) continue;
      if (!p.id) { p.id = newPhotoId(); changed = true; }
      if (p.url && isDataUrl(p.url)) {
        try {
          await photoSave(p.id, p.url, p.name, p.type, p.size);
          p.stored = true;
          delete p.url;
          changed = true;
        } catch (e) {
          p.stored = false;
          toast('Could not move a photo to device storage: ' + (e.message || e));
        }
      } else if (p.url && isRemotePhoto(p.url)) {
        p.remote = true;
        p.stored = true;
      } else if (!p.url) {
        p.stored = true;
      }
    }
  }
  if (changed) saveLocalOnly();
}

function sanitizeRecipesForSync(recipes) {
  return (recipes || []).map(function (r) {
    var c = Object.assign({}, r);
    c.photos = (r && Array.isArray(r.photos) ? r.photos : []).map(function (p) {
      if (!p) return p;
      var meta = {
        id: p.id || newPhotoId(),
        name: p.name || 'photo',
        type: p.type || '',
        size: p.size || 0,
        stored: p.stored !== false,
        remote: !!p.remote,
        added: p.added || 0
      };
      if (p.url && isRemotePhoto(p.url)) meta.url = p.url;
      else if (p.url && isDataUrl(p.url)) {
        _photoCache[meta.id] = p.url;
        if (p.stored === false) meta.url = p.url;
      }
      return meta;
    });
    return c;
  });
}
function photoCount() {
  var n = 0;
  (state.recipes || []).concat(state.trash || []).forEach(function (r) {
    n += (r && r.photos ? r.photos.length : 0);
  });
  return n;
}

/* ===== Payload / persistence ===== */
payload = function () {
  var p = _basePayload();
  p.recipes = sanitizeRecipesForSync(p.recipes);
  p.trash = sanitizeRecipesForSync(p.trash);
  p.tombstones = (state.tombstones || []).slice(-500);
  p.shopBudget = state.shopBudget || '';
  p.schema = 3;
  try { p.device = deviceMeta(); } catch (e) {}
  return p;
};

applyPayload = function (s) {
  _baseApplyPayload(s);
  state.tombstones = Array.isArray(s && s.tombstones) ? s.tombstones : [];
  state.shopBudget = s && s.shopBudget != null ? s.shopBudget : '';
  state.lastLocalBackup = (s && s.lastLocalBackup) || state.lastLocalBackup || 0;
  try { if (typeof filterByTombstones === 'function') filterByTombstones(); } catch (e) {}
  migratePhotos();
};

saveLocalOnly = function () {
  try {
    var data = {
      recipes: sanitizeRecipesForSync(state.recipes),
      cats: state.cats,
      trash: sanitizeRecipesForSync((state.trash || []).slice(-30)),
      history: (state.history || []).slice(-60),
      plan: state.plan,
      shopDone: state.shopDone,
      calendar: state.calendar,
      pantry: state.pantry,
      cookProgress: state.cookProgress,
      timers: state.timers,
      changelog: (state.changelog || []).slice(-100),
      lastBackup: state.lastBackup || 0,
      lastLocalBackup: state.lastLocalBackup || 0,
      lastLocalBackupHash: state.lastLocalBackupHash || '',
      savedViews: state.savedViews || [],
      tombstones: (state.tombstones || []).slice(-500),
      shopBudget: state.shopBudget || '',
      calWeekStart: state.calWeekStart || '',
      schema: 3
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    updateStorageInfo();
  } catch (e) {
    var msg = String(e && e.name === 'QuotaExceededError' ? 'Browser storage is full.' : (e.message || e));
    toast(msg + ' Export a backup, then remove photos or old data.');
    var el = document.getElementById('storageInfo');
    if (el) el.textContent = 'Storage warning: ' + msg + ' Local backups and exports are recommended.';
  }
};

save = function () {
  _baseSave();
  scheduleLocalBackup();
};

/* Existing installs keep their saved category list; add any defaults they are
   missing rather than replacing what the user already has. */
function mergeDefaultCategories() {
  var defaults = (typeof DEFAULT_CATS !== 'undefined') ? DEFAULT_CATS : [];
  if (!defaults.length) return false;
  var current = Array.isArray(state.cats) ? state.cats : [];
  var seen = {};
  current.forEach(function (c) { seen[String(c).toLowerCase()] = true; });
  var added = 0;
  defaults.forEach(function (c) {
    var key = String(c).toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    current.push(c);
    added++;
  });
  if (!added) return false;
  state.cats = current;
  return true;
}

function loadExtras() {
  try {
    var s = JSON.parse(localStorage.getItem(KEY) || '{}');
    state.tombstones = Array.isArray(s.tombstones) ? s.tombstones : [];
    state.shopBudget = s.shopBudget || '';
    state.lastLocalBackup = s.lastLocalBackup || 0;
    state.lastLocalBackupHash = s.lastLocalBackupHash || '';
    state.calWeekStart = s.calWeekStart || '';
  } catch (e) {}
  // Bring older installs up to date with categories they are missing, without
  // touching categories the user added themselves.
  try { if (mergeDefaultCategories()) saveLocalOnly(); } catch (e) {}
}

async function payloadFull() {
  await ensureAllPhotos();
  var p = payload();
  var clone = JSON.parse(JSON.stringify(p));
  clone.recipes = clone.recipes || [];
  clone.trash = clone.trash || [];
  clone.recipes.concat(clone.trash).forEach(function (r) {
    (r.photos || []).forEach(function (ph) {
      if (!ph.url && ph.id && _photoCache[ph.id]) ph.url = _photoCache[ph.id];
    });
  });
  clone.photosIncluded = true;
  return clone;
}

async function saveToFileHandle(showMsg) {
  if (!state.fileHandle) return;
  try {
    if (!(await verifyPerm(state.fileHandle, true))) throw new Error('Permission not granted');
    var enc = !!syncCfg().passphrase;
    var body = await encryptPayload(await payloadFull(), syncCfg().passphrase);
    var w = await state.fileHandle.createWritable();
    await w.write(JSON.stringify(body, null, 2));
    await w.close();
    state.fileName = state.fileHandle.name || state.fileName;
    updateFileInfo(enc ? 'encrypted' : '');
    if (showMsg) toast(enc ? 'Saved encrypted copy to linked file' : 'Saved to linked file');
  } catch (e) {
    if (showMsg) toast('File save failed: ' + (e.message || e));
    updateFileInfo('save failed');
  }
}

async function downloadFallback(link) {
  var body = await encryptPayload(await payloadFull(), syncCfg().passphrase);
  var blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recipe-box.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  if (link) setStatus('fileStatus', 'Browser does not support file linking here; downloaded a full copy (with photos) instead. Use a Chromium-based browser for direct file linking.', 'err');
}

backupReminder = function () {
  var days = 7;
  var due = !state.lastBackup || (now() - state.lastBackup) > days * 86400000;
  if (!due || !state.recipes.length) return;
  setTimeout(async function () {
    if (!confirm('Backup reminder: export a full backup (including photos) now?')) return;
    try {
      var body = await encryptPayload(await payloadFull(), syncCfg().passphrase);
      var blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'recipe-box-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      state.lastBackup = now();
      saveLocalOnly();
    } catch (e) { toast('Backup failed: ' + (e.message || e)); }
  }, 1500);
};

/* ===== Photo add paths ===== */
async function addPhotoToRecipe(r, url, name, type, size) {
  if (!r) return false;
  r.photos = r.photos || [];
  if (r.photos.length >= 8) { toast('Max 8 photos per recipe'); return false; }
  var id = newPhotoId();
  var meta = { id: id, name: name || 'photo', type: type || 'image/jpeg', size: size || (url ? url.length : 0), stored: true, added: now() };
  try {
    await photoSave(id, url, meta.name, meta.type, meta.size);
  } catch (e) {
    meta.stored = false;
    meta.url = url;
    toast('Photo kept in this tab only: ' + (e.message || e));
  }
  r.photos.push(meta);
  r.updated = now();
  return true;
}

addRecipePhoto = function (r) {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = function () {
    var f = inp.files && inp.files[0];
    if (!f) return;
    shrink(f, 1200).then(async function (img) {
      var ok = await addPhotoToRecipe(r, img.url, f.name, 'image/jpeg', img.url.length);
      if (!ok) return;
      save();
      if (document.getElementById('dView') && document.getElementById('dView').open) openView(r.id);
      toast('Photo added');
    }).catch(function (e) { toast(e.message || 'Photo failed'); });
  };
  inp.click();
};

maybeAutoFetchImage = async function (r, doc, baseUrl) {
  try {
    var p = importPrefs();
    if (!p.autoImg) return;
    if (r.photos && r.photos.length) return;
    var u = r._imageUrl || docMetaImage(doc) || '';
    if (!u) return;
    if (u.indexOf('//') === 0) u = 'https:' + u;
    try { u = new URL(u, baseUrl || r.src || location.href).href; } catch (e) {}
    var data = await fetchImageAsDataUrl(u);
    if (data) {
      await addPhotoToRecipe(r, data, 'Imported image', 'image/jpeg', data.length);
    } else if (u) {
      r.photos = [{ id: newPhotoId(), name: 'Imported image', remote: true, stored: true, url: u, added: now() }];
    }
  } catch (e) {
  } finally {
    if (r) delete r._imageUrl;
  }
};

/* ===== Storage reporting ===== */
updateStorageInfo = function () {
  var el = document.getElementById('storageInfo');
  if (!el) return;
  var used = 0;
  try { used = JSON.stringify(localStorage).length; } catch (e) {}
  var base = state.recipes.length + ' recipes \u00b7 ' + Math.round(used / 1024) + ' KB browser data \u00b7 ' + photoCount() + ' photos on device.';
  el.textContent = base;
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(function (est) {
      _lastStorageEstimate = est || {};
      var usage = (est && est.usage) || 0;
      var quota = (est && est.quota) || 0;
      if (!quota) return;
      var pct = usage / quota;
      var txt = base + ' Storage ' + (usage / 1048576).toFixed(1) + ' / ' + (quota / 1048576).toFixed(1) + ' MB.';
      if (pct > 0.8) txt += ' WARNING: storage is nearly full. Export a backup and remove unused photos.';
      el.textContent = txt;
      var detail = document.getElementById('storageDetail');
      if (detail) detail.textContent = 'Recipes: ' + state.recipes.length + ' \u00b7 Photos: ' + photoCount() + ' \u00b7 Browser data: ' + Math.round(used / 1024) + ' KB \u00b7 Device storage: ' + (usage / 1048576).toFixed(1) + ' of ' + (quota / 1048576).toFixed(1) + ' MB (' + Math.round(pct * 100) + '%).';
    }).catch(function () {});
  }
  var detail = document.getElementById('storageDetail');
  if (detail && !_lastStorageEstimate) detail.textContent = 'Recipes: ' + state.recipes.length + ' \u00b7 Photos: ' + photoCount() + ' \u00b7 Browser data: ' + Math.round(used / 1024) + ' KB.';
};

/* ===== Rotating local backups ===== */
function backupHash() {
  try { return stablePayload(payload()); } catch (e) { return ''; }
}
function scheduleLocalBackup() {
  if (_backupTimer) return;
  _backupTimer = setTimeout(function () {
    _backupTimer = null;
    makeLocalBackup('auto');
  }, 8000);
}
async function makeLocalBackup(reason) {
  try {
    if (!state.recipes.length) return null;
    var hash = backupHash();
    if (reason === 'auto' && hash && hash === state.lastLocalBackupHash) return null;
    var data = await payloadFull();
    var rec = {
      id: 'b' + now().toString(36) + Math.random().toString(36).slice(2, 5),
      when: now(),
      reason: reason || 'manual',
      count: state.recipes.length,
      size: JSON.stringify(data).length,
      data: data
    };
    await idbStorePut(BACKUP_STORE, rec.id, rec);
    await pruneLocalBackups(6);
    state.lastLocalBackup = rec.when;
    state.lastLocalBackupHash = hash;
    saveLocalOnly();
    renderBackups();
    if (reason !== 'auto') toast('Local backup saved (' + state.recipes.length + ' recipes)');
    return rec;
  } catch (e) {
    if (reason !== 'auto') toast('Local backup failed: ' + (e.message || e));
    return null;
  }
}
async function pruneLocalBackups(keep) {
  try {
    var all = await idbStoreAll(BACKUP_STORE);
    all.sort(function (a, b) { return (b.when || 0) - (a.when || 0); });
    for (var i = keep; i < all.length; i++) await idbStoreDel(BACKUP_STORE, all[i].id);
  } catch (e) {}
}
async function renderBackups() {
  var el = document.getElementById('localBackupList');
  if (!el) return;
  try {
    var all = await idbStoreAll(BACKUP_STORE);
    all.sort(function (a, b) { return (b.when || 0) - (a.when || 0); });
    el.innerHTML = all.length ? all.map(function (b) {
      return '<div class="itemrow"><div style="flex:1"><strong>' + esc(new Date(b.when).toLocaleString()) + '</strong>' +
        '<div class="small">' + esc(b.reason || 'backup') + ' \u00b7 ' + (b.count || 0) + ' recipes \u00b7 ' + Math.round((b.size || 0) / 1024) + ' KB</div></div>' +
        '<button data-br="' + esc(b.id) + '">Restore</button><button data-bd="' + esc(b.id) + '">Delete</button></div>';
    }).join('') : '<div class="small">No local backups yet. One is saved automatically after changes (kept in this browser).</div>';
    el.onclick = async function (e) {
      var rb = e.target.closest('button[data-br]');
      var db = e.target.closest('button[data-bd]');
      if (rb) await restoreLocalBackup(rb.dataset.br);
      if (db) {
        if (!confirm('Delete this local backup?')) return;
        await idbStoreDel(BACKUP_STORE, db.dataset.bd);
        renderBackups();
      }
    };
  } catch (e) {
    el.innerHTML = '<div class="small">Local backups unavailable: ' + esc(e.message || e) + '</div>';
  }
}
async function restoreLocalBackup(id) {
  try {
    var rec = await idbStoreGet(BACKUP_STORE, id);
    if (!rec || !rec.data) { toast('Backup not found'); return; }
    if (!confirm('Restore the backup from ' + new Date(rec.when).toLocaleString() + '? The current data is backed up first.')) return;
    await makeLocalBackup('before-restore');
    applyPayload(rec.data);
    saveLocalOnly();
    render();
    toast('Backup restored');
    try { document.getElementById('dView').close(); } catch (e) {}
  } catch (e) {
    toast('Restore failed: ' + (e.message || e));
  }
}
async function maybeAutoBackup() {
  if (!state.recipes.length) return;
  var age = now() - (state.lastLocalBackup || 0);
  if (age > 24 * 3600 * 1000) await makeLocalBackup('daily');
}

/* ===== Store UI wiring ===== */
function initStoreUI() {
  var nowBtn = document.getElementById('localBackupNow');
  if (nowBtn) nowBtn.onclick = function () { makeLocalBackup('manual'); };
  var chk = document.getElementById('sCheckStorage');
  if (chk) chk.onclick = function () { updateStorageInfo(); toast('Storage information refreshed'); };
  var openB = document.getElementById('sOpenBackups');
  if (openB) openB.onclick = function () {
    try { document.getElementById('dSet').close(); } catch (e) {}
    try { document.getElementById('dFile').showModal(); } catch (e) {}
    renderBackups();
  };
  var backNow = document.getElementById('sBackupNow');
  if (backNow) backNow.onclick = function () { makeLocalBackup('manual'); };
  renderBackups();
  updateStorageInfo();
}
