// Recipe Box - single-port server for container deployments.
//
// Serves the PWA bundle AND the sync API on one port, so the ZimaOS/CasaOS
// store only has to publish a single port. Data lives in RECIPEBOX_DATA so it
// can sit on a persistent volume.
//
// Binds 0.0.0.0 by default, which is required inside a container.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
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

    if (TOKEN) {
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
        counts: {
          recipes: Array.isArray(data.recipes) ? data.recipes.length : 0,
          tombstones: Array.isArray(data.tombstones) ? data.tombstones.length : 0,
          versions: listVersions().length
        }
      });
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

ensure();
server.listen(PORT, HOST, () => {
  console.log(`Recipe Box listening on http://${HOST}:${PORT}`);
  console.log(`Serving PWA from ${WWW_DIR}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(TOKEN ? 'Auth: Bearer token required' : 'Auth: none (set RECIPEBOX_TOKEN to require)');
});