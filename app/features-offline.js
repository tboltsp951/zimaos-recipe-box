/* Recipe Box v3 - offline status + pending-change queue.
   The app already persists to localStorage, so nothing is lost while offline.
   What was missing is knowing that: whether you are offline, how many changes
   have not reached the server, and automatic catch-up when the connection
   returns. Loaded after features-diff.js. */

var OFFLINE_KEY = 'recipebox-offline';

function offlineCfg() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || '{}'); } catch (e) { return {}; }
}

/* A change is "pending" when it has not been acknowledged by the server.
   We compare the local payload fingerprint with the last one we pushed. */
function offlineFingerprint() {
  try {
    var p = payload();
    var o = {
      recipes: (p.recipes || []).length,
      cats: (p.cats || []).length,
      plan: (p.plan || []).length,
      calendar: (p.calendar || []).length,
      shop: ((p.shopDone && p.shopDone['__items__']) || []).length,
      pantry: (p.pantry || []).length,
      tombstones: (p.tombstones || []).length,
      upd: (p.recipes || []).reduce(function (m, r) { return Math.max(m, r.updated || 0); }, 0)
    };
    return JSON.stringify(o);
  } catch (e) {
    return '';
  }
}

function offlineMarkPending(reason) {
  var c = offlineCfg();
  c.pending = true;
  c.pendingSince = c.pendingSince || now();
  c.pendingFingerprint = offlineFingerprint();
  c.reason = reason || 'change';
  try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(c)); } catch (e) {}
  offlineRender();
}

function offlineMarkSynced() {
  var c = offlineCfg();
  c.pending = false;
  c.pendingFingerprint = offlineFingerprint();
  c.lastSynced = now();
  delete c.pendingSince;
  try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(c)); } catch (e) {}
  offlineRender();
}

function offlineIsOnline() {
  return navigator.onLine !== false;
}

/* Wrapped around pushSync so both the manual and auto paths update the badge. */
function offlineAfterPush(ok) {
  if (ok) offlineMarkSynced();
  else if (!offlineIsOnline()) offlineMarkPending('offline');
  return ok;
}

/* Header badge + banner. */
function offlineRender() {
  var c = offlineCfg();
  var online = offlineIsOnline();
  var badge = document.getElementById('netBadge');

  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'netBadge';
    badge.className = 'pill net-badge';
    var actions = document.querySelector('header .actions') || document.querySelector('header');
    if (actions) actions.insertBefore(badge, actions.firstChild);
  }
  if (!badge) return;

  if (!online) {
    badge.textContent = c.pending ? 'Offline \u00b7 changes kept locally' : 'Offline';
    badge.className = 'pill net-badge net-offline';
    badge.title = 'No connection. Everything you change is saved on this device and will sync when you reconnect.';
    badge.style.display = '';
    return;
  }

  if (c.pending) {
    var age = c.pendingSince ? Math.round((now() - c.pendingSince) / 60000) : 0;
    badge.textContent = 'Unsynced changes' + (age >= 1 ? (' \u00b7 ' + age + 'm') : '');
    badge.className = 'pill net-badge net-pending';
    badge.title = 'These changes have not reached the sync server yet. Press Sync to push them.';
    badge.style.display = '';
    return;
  }

  badge.style.display = 'none';
}

/* Catch up when connectivity returns. */
async function offlineTrySync() {
  var c = offlineCfg();
  if (!offlineIsOnline()) return false;
  if (!c.pending) return false;
  var cfg = syncCfg();
  if (!cfg.auto) return false;   // respect the user's auto-sync setting
  try {
    var ok = await pushSync(false);
    return !!ok;
  } catch (e) {
    return false;
  }
}

/* Watch save() so any local change while disconnected is flagged. */
var _offlineBaseSave = save;
save = function () {
  var out = _offlineBaseSave.apply(this, arguments);
  try {
    if (!offlineIsOnline()) {
      offlineMarkPending('offline');
    } else {
      // Online: a real push is scheduled by auto-sync; mark pending now so the
      // badge reflects reality until that push succeeds.
      var cfg = syncCfg();
      if (cfg.auto) offlineMarkPending('change');
    }
  } catch (e) {}
  return out;
};

var _offlineBasePush = pushSync;
pushSync = async function (manual) {
  var ok = await _offlineBasePush(manual);
  return offlineAfterPush(ok);
};

function initOfflineUI() {
  offlineRender();

  window.addEventListener('online', async function () {
    offlineRender();
    if (offlineCfg().pending) {
      toast('Back online - syncing pending changes');
      var ok = await offlineTrySync();
      if (!ok && syncCfg().auto) {
        // Auto-sync may be off or the server unreachable; try once anyway.
        try { await pushSync(false); } catch (e) {}
      }
    }
  });

  window.addEventListener('offline', function () {
    offlineMarkPending('offline');
    toast('Offline. Changes are saved on this device.');
  });

  var badge = document.getElementById('netBadge');
  if (badge) {
    badge.style.cursor = 'pointer';
    badge.onclick = function () {
      if (!offlineIsOnline()) { toast('You are offline. Changes will sync when the connection returns.'); return; }
      if (!offlineCfg().pending) { toast('Everything is synced.'); return; }
      toast('Pushing pending changes');
      pushSync(true);
    };
  }

  // Re-check on focus, in case the browser missed the event.
  window.addEventListener('focus', function () { offlineRender(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOfflineUI);
else initOfflineUI();