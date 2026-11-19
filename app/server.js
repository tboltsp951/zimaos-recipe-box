// Recipe Box - single-port server for local and container deployments.
//
// Serves the PWA bundle AND the sync API on one port, so the ZimaOS/CasaOS
// store only has to publish a single port. Data lives in DATA_DIR /
// RECIPEBOX_DATA so it can sit on a persistent volume.
//
// Binds 0.0.0.0 by default, which is required inside a container.
//
// It also proxies recipe-page fetches: browsers cannot read most recipe sites
// (CORS) and public relays are frequently blocked, but this process fetches
// from the user's own network, which the sites normally allow.

const http = require('http');
const http2 = require('http2');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.RECIPEBOX_TOKEN || '';
// The container sets DATA_DIR (matching the other zimaos apps); RECIPEBOX_DATA
// is accepted too, and local runs fall back to ./data.
const DATA_DIR = process.env.RECIPEBOX_DATA || process.env.DATA_DIR || path.join(__dirname, 'data');
// In the container the PWA sits next to server.js (COPY app/ /app/), so the
// default is this directory. RECIPEBOX_WWW can point elsewhere if needed.
const WWW_DIR = process.env.RECIPEBOX_WWW || __dirname;

const DATA_FILE = path.join(DATA_DIR, 'recipebox.json');
const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const MAX_VERSIONS = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const cats = ['Breakfast','Mains','Desserts','Salads','Soups','Poultry','Fish','Meat',
      'Vegetables','Appetizers','Sauces','Side Dishes','Bakery','Pasta','Casseroles',
      'Snacks','Beverages','Rubs'];
    fs.writeFileSync(DATA_FILE, JSON.stringify({ recipes: [], cats: cats }, null, 2));
  }
}

function sendJson(res, code, body, headers) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  }, headers || {});
  res.writeHead(code, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Device metadata is informational and changes on every push; excluding it from
// the comparison stops pointless version snapshots.
function stripSync(obj) {
  const copy = Object.assign({}, obj || {});
  delete copy.syncedAt;
  delete copy.exportedAt;
  delete copy.device;
  return JSON.stringify(copy);
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}'); } catch (e) { return {}; }
}

function listVersions() {
  if (!fs.existsSync(VERSIONS_DIR)) return [];
  return fs.readdirSync(VERSIONS_DIR)
    .filter(name => /^recipebox-[\w.-]+\.json$/.test(name))
    .map(name => {
      const st = fs.statSync(path.join(VERSIONS_DIR, name));
      let device = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(VERSIONS_DIR, name), 'utf8') || '{}');
        if (parsed && parsed.device) device = { id: parsed.device.id || '', name: parsed.device.name || '' };
      } catch (e) {}
      return { name, savedAt: st.mtime.toISOString(), size: st.size, device };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function pruneVersions() {
  const all = fs.readdirSync(VERSIONS_DIR)
    .filter(name => /^recipebox-[\w.-]+\.json$/.test(name))
    .map(name => ({ name, t: fs.statSync(path.join(VERSIONS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  all.slice(MAX_VERSIONS).forEach(v => {
    try { fs.unlinkSync(path.join(VERSIONS_DIR, v.name)); } catch (e) {}
  });
}

function saveVersion(obj) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(path.join(VERSIONS_DIR, `recipebox-${stamp}.json`), JSON.stringify(obj, null, 2));
    pruneVersions();
  } catch (e) {
    console.error('Could not write version backup:', e.message);
  }
}

// ---- Import fetch proxy --------------------------------------------------
// The PWA asks for a page; this process loads it with browser-like headers and
// returns the HTML. Requests to private/loopback addresses are refused so the
// endpoint cannot be used to probe the local network (SSRF).

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 6 * 1024 * 1024;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1'
};

function isPrivateAddress(ip) {
  if (!ip) return true;
  let v = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (v.indexOf('::ffff:') === 0) v = v.slice(7);
  if (v === '::1' || v === '::' || v === '0.0.0.0') return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true; // ULA and link-local
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls are allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('invalid url');
  if (host === 'localhost' || /\.(local|internal|home\.arpa|lan)$/.test(host)) {
    throw new Error('local addresses are not allowed');
  }
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') > -1;
  let addrs;
  if (literal) {
    addrs = [host];
  } else {
    try { addrs = (await dns.promises.lookup(host, { all: true })).map(a => a.address); }
    catch (e) { throw new Error('could not resolve ' + host); }
  }
  if (!addrs.length) throw new Error('could not resolve ' + host);
  for (const a of addrs) {
    if (isPrivateAddress(a)) throw new Error('local addresses are not allowed');
  }
  return u;
}

// Some CDNs (Akamai in front of Allrecipes, for example) answer HTTP/1.1 with
// 402 Payment Required and only serve the page over HTTP/2, which Node's fetch
// does not use. Talk HTTP/2 for https, then fall back to HTTP/1.1 for plain http
// and for sites that do not negotiate h2, so the proxy behaves like a browser.
function http1Get(target, timeoutMs, maxBytes) {
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise(function (resolve, reject) {
    let settled = false, req = null, status = 0, head = {}, total = 0;
    const chunks = [];

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (req) req.destroy(); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }

    const timer = setTimeout(function () {
      finish(new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's'));
    }, timeoutMs);

    function fail(e) {
      finish(new Error('could not reach the site (' + ((e && e.message) || e) + ')'));
    }

    req = lib.request(target, { method: 'GET', headers: FETCH_HEADERS }, function (res) {
      status = res.statusCode || 0;
      head = res.headers || {};
      const declared = parseInt(head['content-length'] || '0', 10);
      if (declared && declared > maxBytes) return finish(new Error('page too large'));
      if (status >= 300 && status < 400 && head['location']) {
        return finish(null, { redirect: new URL(String(head['location']), target.href).href });
      }
      if (status < 200 || status >= 300) return finish(new Error('upstream HTTP ' + status));
      res.on('data', function (chunk) {
        total += chunk.length;
        if (total > maxBytes) { finish(new Error('page too large')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', function () {
        const type = String(head['content-type'] || '');
        const html = Buffer.concat(chunks).toString('utf8');
        if (!/html|xml|text/i.test(type) && !/<html|<!doctype/i.test(html.slice(0, 500))) {
          return finish(new Error('not an HTML page (' + (type || 'unknown type') + ')'));
        }
        finish(null, { status: status, url: target.href, contentType: type, html: html });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

function http2Get(target, timeoutMs, maxBytes) {
  return new Promise(function (resolve, reject) {
    let settled = false, session = null, req = null, status = 0, head = {}, total = 0;
    const chunks = [];

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (req && req.destroy) req.destroy(); } catch (e) {}
      try { if (session) session.close(); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }

    const timer = setTimeout(function () {
      finish(new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's'));
    }, timeoutMs);

    // Connection-level failures can be retried over HTTP/1.1.
    function retryable(e) {
      const err = new Error('could not reach the site (' + ((e && e.message) || e) + ')');
      err.retryable = true;
      finish(err);
    }

    try {
      session = http2.connect(target.origin);
      session.on('error', retryable);
      // Only :method and :path. Node fills :scheme/:authority itself; sending
      // them explicitly makes Akamai answer 402.
      req = session.request(Object.assign({
        ':method': 'GET',
        ':path': target.pathname + target.search
      }, FETCH_HEADERS));
      req.on('response', function (h) {
        status = h[':status'] || 0;
        head = h;
        const declared = parseInt(head['content-length'] || '0', 10);
        if (declared && declared > maxBytes) return finish(new Error('page too large'));
        if (status >= 300 && status < 400 && head['location']) {
          return finish(null, { redirect: new URL(String(head['location']), target.href).href });
        }
        if (status < 200 || status >= 300) return finish(new Error('upstream HTTP ' + status));
      });
      req.on('data', function (chunk) {
        total += chunk.length;
        if (total > maxBytes) return finish(new Error('page too large'));
        chunks.push(chunk);
      });
      req.on('end', function () {
        if (settled) return;
        const type = String(head['content-type'] || '');
        const html = Buffer.concat(chunks).toString('utf8');
        if (!/html|xml|text/i.test(type) && !/<html|<!doctype/i.test(html.slice(0, 500))) {
          return finish(new Error('not an HTML page (' + (type || 'unknown type') + ')'));
        }
        finish(null, { status: status, url: target.href, contentType: type, html: html });
      });
      req.on('error', retryable);
      req.end();
    } catch (e) {
      retryable(e);
    }
  });
}

async function httpGetText(target, timeoutMs, maxBytes) {
  if (target.protocol !== 'https:') return http1Get(target, timeoutMs, maxBytes);
  try {
    return await http2Get(target, timeoutMs, maxBytes);
  } catch (e) {
    // Real HTTP responses are not retried; only connection/protocol failures.
    if (!e || !e.retryable) throw e;
    return http1Get(target, timeoutMs, maxBytes);
  }
}

// A site can block the address of the box itself, which no amount of browser-like
// headers fixes. Google's translate proxy fetches the page from a different IP
// and returns the same HTML (with rewritten links), so retry through it before
// giving up. The JSON-LD recipe data is left intact.
function translateMirror(href) {
  let u;
  try { u = new URL(String(href)); } catch (e) { return ''; }
  if (u.protocol !== 'https:' || /\.translate\.goog$/i.test(u.hostname)) return '';
  const host = u.hostname.toLowerCase().replace(/\./g, '-');
  const mirror = new URL('https://' + host + '.translate.goog' + u.pathname);
  u.searchParams.forEach((v, k) => mirror.searchParams.append(k, v));
  mirror.searchParams.set('_x_tr_sl', 'auto');
  mirror.searchParams.set('_x_tr_tl', 'en');
  mirror.searchParams.set('_x_tr_hl', 'en');
  return mirror.href;
}

async function fetchPageHtml(raw) {
  let current = String(raw);
  let triedMirror = false;
  for (let hop = 0; hop < 6; hop++) {
    const target = await assertPublicHttpUrl(current);
    let out;
    try {
      out = await httpGetText(target, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES);
    } catch (e) {
      // Only retry real fetch failures; a refused private address or an invalid
      // URL must stay an immediate error. The mirror is tried once, only for a
      // direct https fetch, and its own failure is never mirrored again.
      const msg = String((e && e.message) || e);
      const fetchFailure = /^(upstream HTTP|timed out|could not reach the site)/.test(msg);
      const mirror = triedMirror ? '' : translateMirror(target.href);
      if (!fetchFailure || !mirror) throw e;
      triedMirror = true;
      try {
        const mirrored = await assertPublicHttpUrl(mirror);
        const alt = await httpGetText(mirrored, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES);
        if (alt && !alt.redirect) return Object.assign({}, alt, { via: 'translate' });
      } catch (e2) {
        // Keep the original error: it explains why the direct fetch failed.
      }
      throw e;
    }
    if (out && out.redirect) { current = out.redirect; continue; }
    return out;
  }
  throw new Error('too many redirects');
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve inside WWW_DIR only.
  const filePath = path.join(WWW_DIR, rel);
  if (!filePath.startsWith(WWW_DIR + path.sep) && filePath !== WWW_DIR) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    let target = filePath;
    if (err || !stat.isFile()) {
      // SPA fallback so app routes and the share-target redirect resolve.
      target = path.join(WWW_DIR, 'index.html');
      if (!fs.existsSync(target)) { res.writeHead(404).end('not found'); return; }
    }
    const ext = path.extname(target).toLowerCase();
    // HTML/JS must revalidate so a redeploy is picked up immediately.
    const cache = (ext === '.html' || ext === '.js' || ext === '.webmanifest')
      ? 'no-cache'
      : 'public, max-age=86400';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache
    });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, '');
    }

    let url;
    try { url = new URL(req.url, `http://localhost:${PORT}`); }
    catch (e) { return sendJson(res, 400, { error: 'bad request' }); }

    const isApi = url.pathname === '/api/recipebox' || url.pathname.startsWith('/api/recipebox/');

    // The token protects the API only; the PWA itself must stay loadable so the
    // browser can present the token it was configured with.
    if (TOKEN && isApi) {
      const auth = req.headers['authorization'] || '';
      if (auth !== 'Bearer ' + TOKEN) return sendJson(res, 401, { error: 'unauthorized' });
    }

    ensure();

    if (url.pathname === '/api/recipebox/info' && req.method === 'GET') {
      const data = readData();
      return sendJson(res, 200, {
        ok: true,
        app: 'Recipe Box',
        dataDir: DATA_DIR,
        syncedAt: data.syncedAt || null,
        device: data.device || null,
        encrypted: !!data.enc,
        fetch: true,
        counts: {
          recipes: Array.isArray(data.recipes) ? data.recipes.length : 0,
          tombstones: Array.isArray(data.tombstones) ? data.tombstones.length : 0,
          versions: listVersions().length
        }
      });
    }

    if (url.pathname === '/api/recipebox/fetch' && req.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(target)) {
        return sendJson(res, 400, { ok: false, error: 'url must start with http:// or https://' });
      }
      try {
        const page = await fetchPageHtml(target);
        return sendJson(res, 200, Object.assign({ ok: true }, page));
      } catch (e) {
        const msg = e && e.message ? e.message : 'fetch failed';
        const code = /not allowed|invalid url|only http/i.test(msg) ? 400 : 502;
        return sendJson(res, code, { ok: false, error: msg });
      }
    }

    if (url.pathname === '/api/recipebox/versions' && req.method === 'GET') {
      return sendJson(res, 200, { versions: listVersions() });
    }

    if (url.pathname.startsWith('/api/recipebox/versions/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/api/recipebox/versions/'.length));
      if (!/^recipebox-[\w.-]+\.json$/.test(name) || path.basename(name) !== name) {
        return sendJson(res, 400, { error: 'invalid version name' });
      }
      const file = path.join(VERSIONS_DIR, name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'version not found' });
      return sendJson(res, 200, fs.readFileSync(file, 'utf8'));
    }

    if (url.pathname === '/api/recipebox') {
      if (req.method === 'GET') {
        return sendJson(res, 200, fs.readFileSync(DATA_FILE, 'utf8') || '{}');
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const raw = await readBody(req);
        let obj;
        try { obj = JSON.parse(raw || '{}'); }
        catch (e) { return sendJson(res, 400, { error: 'invalid json' }); }
        try {
          const existing = readData();
          if (existing && Object.keys(existing).length && stripSync(existing) !== stripSync(obj)) {
            saveVersion(existing);
          }
        } catch (e) {}
        obj.syncedAt = new Date().toISOString();
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
        return sendJson(res, 200, { ok: true, syncedAt: obj.syncedAt });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (isApi) return sendJson(res, 404, { error: 'not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return sendJson(res, 500, { error: e.message || 'server error' });
  }
});

// Exported so the fetch helpers can be unit tested without starting a server.
module.exports = { fetchPageHtml, translateMirror, isPrivateAddress, assertPublicHttpUrl };

if (require.main === module) {
  ensure();
  server.listen(PORT, HOST, () => {
    console.log(`Recipe Box listening on http://${HOST}:${PORT}`);
    console.log(`Serving PWA from ${WWW_DIR}`);
    console.log(`Data file: ${DATA_FILE}`);
    console.log(`Import fetch proxy: /api/recipebox/fetch?url=...`);
    console.log(TOKEN ? 'Auth: Bearer token required for /api/*' : 'Auth: none (set RECIPEBOX_TOKEN to require)');
  });
}
