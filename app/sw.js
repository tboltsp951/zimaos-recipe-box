const CACHE = 'recipe-box-v22';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './features-store.js',
  './features-plan.js',
  './features-content.js',
  './features-sync.js',
  './features-camera.js',
  './features-recs.js',
  './features-subs.js',
  './features-shelf.js',
  './features-cards.js',
  './features-review.js',
  './features-prep.js',
  './features-search.js',
  './features-import.js',
  './features-offline.js',
  './features-diff.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
self.addEventListener('install', (e) => {
  // Keep the new worker waiting so the page can show an explicit "Reload to update" prompt.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && !k.includes('__share__')).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'SW_UPDATED' });
  })());
});
async function handleShareTarget(e) {
  const form = await e.request.formData();
  const title = form.get('title') || '';
  const text = form.get('text') || '';
  const url = form.get('url') || '';
  const files = form.getAll('media').filter(Boolean);
  const cache = await caches.open(CACHE);
  const payload = { title, text, url, files: [] };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const key = `./__share__/file-${Date.now()}-${i}-${encodeURIComponent(f.name||'file')}`;
    await cache.put(new Request(key), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
    payload.files.push({ key, name: f.name, type: f.type });
  }
  await cache.put(new Request('./__share__/pending'), new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect('./index.html?share-target=1', 303);
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/index.html') && url.searchParams.get('share-target') === '1') {
    e.respondWith(handleShareTarget(e));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.pathname.includes('/__share__/')) {
    e.respondWith(caches.match(req));
    return;
  }
  if (url.origin !== location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const copy = res.clone();
        const c = await caches.open(CACHE);
        c.put(req, copy);
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('Offline and not cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      e.waitUntil(fetch(req).then(res => caches.open(CACHE).then(c => c.put(req, res.clone()))).catch(()=>{}));
      return cached;
    }
    try {
      const res = await fetch(req);
      const copy = res.clone();
      const c = await caches.open(CACHE);
      c.put(req, copy);
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});