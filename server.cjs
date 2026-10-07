// AnimStudio local server (no dependencies).
//   - serves the editor
//   - lists models (AnimStudio/models) and exports
//   - stores projects / autosaves in AnimStudio/projects and exports in AnimStudio/exports
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE_PORT = Number(process.env.PORT) || 5173;
let PORT = BASE_PORT;
const APP_DIR = __dirname;
const MODEL_DIR = path.join(APP_DIR, 'models'); // your characters, incl. rigged ones from the skeleton builder
const EXPORT_DIR = path.join(APP_DIR, 'exports');
const PROJECT_DIR = path.join(APP_DIR, 'projects');
const AUTOSAVE_DIR = path.join(PROJECT_DIR, '.autosave');
const LIBRARY_DIR = path.join(APP_DIR, 'library');
const ANIM_DIR = path.join(APP_DIR, 'animations'); // animation packs (GLBs full of moves) for the Move Maker
const PROPS_DIR = path.join(APP_DIR, 'props');
const MAX_BODY = 512 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

for (const d of [EXPORT_DIR, PROJECT_DIR, AUTOSAVE_DIR, LIBRARY_DIR, PROPS_DIR, MODEL_DIR, ANIM_DIR]) fs.mkdirSync(d, { recursive: true });

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** Resolve `rel` inside `base`; null if it escapes. */
function safeJoin(base, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const p = path.resolve(base, '.' + path.sep + decoded);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

const cleanName = (n, exts) => {
  const base = path.basename(String(n || '')).replace(/[^\w.\- ()]/g, '_').trim();
  if (!base || base.startsWith('.')) return null;
  return exts.some((e) => base.toLowerCase().endsWith(e)) ? base : null;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listModels() {
  const out = [];
  for (const f of listFiles(MODEL_DIR, ['.glb', '.gltf'])) out.push({ ...f, url: `/models/${encodeURIComponent(f.name)}`, folder: 'AnimStudio/models' });
  for (const f of listFiles(EXPORT_DIR, ['.glb'])) out.push({ ...f, url: `/exports/${encodeURIComponent(f.name)}`, folder: 'Exports' });
  return out;
}

function listProjects() {
  return listFiles(PROJECT_DIR, ['.animproj.json']).map((f) => {
    let model = null,
      clips = null,
      thumb = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, f.name), 'utf8'));
      model = j.model || null;
      clips = Array.isArray(j.clips) ? j.clips.length : null;
      thumb = typeof j.thumb === 'string' && j.thumb.startsWith('data:image/') ? j.thumb : null;
    } catch {}
    return { ...f, model, clips, thumb };
  });
}

// ---------------------------------------------------------------------------
// Live bridge: MCP / scripts -> server -> the open AnimStudio browser tab -> result back.
// ---------------------------------------------------------------------------
const bridge = { clients: new Set(), pending: new Map(), next: 1 };
const SSE_END = String.fromCharCode(10, 10);
setInterval(() => bridge.clients.forEach((r) => r.write(': ping' + SSE_END)), 20000).unref();

function bridgeCall(cmd, args, timeoutMs = 120000) {
  const client = [...bridge.clients].pop();
  if (!client) return Promise.reject(Object.assign(new Error('AnimStudio is not open in a browser. Start it (start.bat) and keep the tab open.'), { status: 503 }));
  const id = bridge.next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(Object.assign(new Error(`AnimStudio did not answer "${cmd}" in time`), { status: 504 }));
    }, timeoutMs);
    bridge.pending.set(id, { resolve, reject, timer });
    client.write('data: ' + JSON.stringify({ id, cmd, args }) + SSE_END);
  });
}

async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/bridge/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected' + SSE_END);
    bridge.clients.add(res);
    req.on('close', () => bridge.clients.delete(res));
    return;
  }
  if (p === '/api/bridge/status') return json(res, { connected: bridge.clients.size });
  if (p === '/api/bridge/result' && req.method === 'POST') {
    const msg = JSON.parse((await readBody(req)).toString('utf8'));
    const pend = bridge.pending.get(msg.id);
    if (pend) {
      clearTimeout(pend.timer);
      bridge.pending.delete(msg.id);
      pend.resolve(msg);
    }
    return json(res, { ok: true });
  }
  if (p === '/api/bridge/call' && req.method === 'POST') {
    const { cmd, args, timeout } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    try {
      const r = await bridgeCall(cmd, args || {}, Math.min(900000, timeout || 120000));
      return json(res, r);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, e.status || 500);
    }
  }

  if (p === '/api/models') return json(res, { models: listModels() });
  if (p === '/api/animpacks') return json(res, { packs: listFiles(ANIM_DIR, ['.glb']).map((f) => f.name) });
  if (p === '/api/projects') return json(res, { projects: listProjects() });
  if (p === '/api/info') return json(res, { exportDir: EXPORT_DIR, projectDir: PROJECT_DIR, modelDir: MODEL_DIR });

  // My move library: AnimStudio/library/*.move.json (moves on the standard skeleton)
  if (p === '/api/library') {
    const moves = [];
    for (const f of listFiles(LIBRARY_DIR, ['.move.json'])) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, f.name), 'utf8'));
        moves.push({ file: f.name, name: j.name, category: j.category, duration: j.clip?.duration, loop: j.clip?.loop, note: j.note, saved: f.mtime });
      } catch {}
    }
    return json(res, { moves, dir: LIBRARY_DIR });
  }
  if (p === '/api/library/item') {
    const name = cleanName(q.get('file'), ['.move.json']);
    if (!name) return json(res, { error: 'Bad file name' }, 400);
    const file = path.join(LIBRARY_DIR, name);
    if (req.method === 'GET') return serveFile(res, file);
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      JSON.parse(body.toString('utf8'));
      fs.writeFileSync(file, body);
      return json(res, { path: file });
    }
    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, { ok: true });
    }
  }

  if (p === '/api/project') {
    const name = cleanName(q.get('name'), ['.animproj.json']);
    if (!name) return json(res, { error: 'Bad project name' }, 400);
    const file = path.join(PROJECT_DIR, name);
    if (req.method === 'GET') return serveFile(res, file);
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      JSON.parse(body.toString('utf8')); // validate
      fs.writeFileSync(file + '.tmp', body);
      fs.renameSync(file + '.tmp', file);
      return json(res, { path: file });
    }
    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, { ok: true });
    }
  }

  if (p === '/api/autosave') {
    const model = cleanName((q.get('model') || '') + '.json', ['.json']);
    if (!model) return json(res, { error: 'Bad model' }, 400);
    const file = path.join(AUTOSAVE_DIR, model);
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return json(res, { none: true });
      return serveFile(res, file);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      fs.writeFileSync(file, body);
      return json(res, { path: file });
    }
    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, { ok: true });
    }
  }

  if (p === '/api/export' && req.method === 'POST') {
    const name = cleanName(q.get('name'), ['.glb', '.json']);
    if (!name) return json(res, { error: 'Only .glb or .json files' }, 400);
    const body = await readBody(req);
    const file = path.join(EXPORT_DIR, name);
    fs.writeFileSync(file, body);
    console.log('Exported', file, `(${(body.length / 1024).toFixed(0)} KB)`);
    return json(res, { path: file, size: body.length });
  }

  // Rigged characters (made by the skeleton builder) live in AnimStudio/models.
  if (p === '/api/model' && (req.method === 'PUT' || req.method === 'POST')) {
    const name = cleanName(q.get('name'), ['.glb']);
    if (!name) return json(res, { error: 'Only .glb files' }, 400);
    const body = await readBody(req);
    const file = path.join(MODEL_DIR, name);
    fs.writeFileSync(file + '.tmp', body);
    fs.renameSync(file + '.tmp', file);
    console.log('Saved rigged model', file);
    return json(res, { path: file, url: `/models/${encodeURIComponent(name)}`, size: body.length });
  }

  // Props (weapons, tools…) to attach to sockets: AnimStudio/props/*.glb
  if (p === '/api/props') return json(res, { props: listFiles(PROPS_DIR, ['.glb', '.gltf']).map((f) => ({ ...f, url: `/props/${encodeURIComponent(f.name)}` })), dir: PROPS_DIR });
  if (p === '/api/prop' && (req.method === 'PUT' || req.method === 'POST')) {
    const name = cleanName(q.get('name'), ['.glb']);
    if (!name) return json(res, { error: 'Only .glb files' }, 400);
    const body = await readBody(req);
    const file = path.join(PROPS_DIR, name);
    fs.writeFileSync(file, body);
    return json(res, { path: file, url: `/props/${encodeURIComponent(name)}` });
  }

  // Animation packs (start page › ＋ Add animations): AnimStudio/animations/*.glb
  if (p === '/api/animpack' && (req.method === 'PUT' || req.method === 'DELETE')) {
    const name = cleanName(q.get('name'), ['.glb']);
    if (!name) return json(res, { error: 'Only .glb files' }, 400);
    const file = path.join(ANIM_DIR, name);
    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      console.log('Removed animation pack', file);
      return json(res, { ok: true });
    }
    const body = await readBody(req);
    fs.writeFileSync(file + '.tmp', body);
    fs.renameSync(file + '.tmp', file);
    console.log('Saved animation pack', file, `(${(body.length / 1e6).toFixed(1)} MB)`);
    return json(res, { path: file, url: `/animations/${encodeURIComponent(name)}`, size: body.length });
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const target = path.resolve(q.get('path') || '');
    const allowed = [EXPORT_DIR, PROJECT_DIR, LIBRARY_DIR, PROPS_DIR, MODEL_DIR].some((d) => target === d || target.startsWith(d + path.sep));
    if (!allowed || !fs.existsSync(target)) return json(res, { error: 'Not allowed' }, 403);
    if (process.platform === 'win32') execFile('explorer.exe', [fs.statSync(target).isDirectory() ? target : `/select,${target}`]);
    else if (process.platform === 'darwin') execFile('open', ['-R', target]);
    else execFile('xdg-open', [path.dirname(target)]);
    return json(res, { ok: true });
  }

  return json(res, { error: 'Unknown API' }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, url);

    // "/models/1/x.glb" is the old (two-folder) form of "/models/x.glb"; still accepted.
    const m = /^\/models\/(?:\d+\/)?(.+)$/.exec(p);
    if (m) {
      const f = safeJoin(MODEL_DIR, m[1]);
      return f ? serveFile(res, f) : send(res, 403, 'Forbidden');
    }
    if (p.startsWith('/props/')) {
      const f = safeJoin(PROPS_DIR, p.slice('/props/'.length));
      return f ? serveFile(res, f) : send(res, 403, 'Forbidden');
    }
    if (p.startsWith('/exports/')) {
      const f = safeJoin(EXPORT_DIR, p.slice('/exports/'.length));
      return f ? serveFile(res, f) : send(res, 403, 'Forbidden');
    }
    // App files; node_modules only for three.js.
    if (p.startsWith('/node_modules/') && !p.startsWith('/node_modules/three/')) return send(res, 403, 'Forbidden');
    if (p.startsWith('/projects/') || p.startsWith('/exports/') || /\.(cjs)$/.test(p)) return send(res, 403, 'Forbidden');
    const f = safeJoin(APP_DIR, p === '/' ? 'index.html' : p.slice(1));
    return f ? serveFile(res, f) : send(res, 403, 'Forbidden');
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

// If the port is taken (e.g. an older copy is still running) try the next few.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && PORT < BASE_PORT + 10) {
    PORT++;
    server.listen(PORT, '127.0.0.1');
    return;
  }
  throw e;
});

server.on('listening', () => {
  const url = `http://localhost:${PORT}`;
  try {
    fs.writeFileSync(path.join(APP_DIR, '.port'), String(PORT)); // lets the MCP server find us
  } catch {}
  console.log(`\n  AnimStudio  →  ${url}\n`);
  console.log(`  Models:   ${MODEL_DIR}`);
  console.log(`  Exports:  ${EXPORT_DIR}`);
  console.log(`  Projects: ${PROJECT_DIR}\n`);
  console.log('  Keep this window open while you work. Close it to stop AnimStudio.\n');
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
});

server.listen(PORT, '127.0.0.1');
