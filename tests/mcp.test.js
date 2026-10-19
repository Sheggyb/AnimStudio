// The MCP server's protocol over stdio: both eras, tool metadata, errors (AnimStudio need not run).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assert, ROOT } from './helpers.js';

/** Start mcp/server.mjs pointing at a port where nothing runs; returns { request, close }. */
function server() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], { env: { ...process.env, ANIMSTUDIO_PORT: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
        waiting.set(n, (m) => (clearTimeout(timer), resolve(m)));
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      }),
    notify: (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    close: () => proc.stdin.end(),
  };
}

const modern = (extra = {}) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, ...extra });

export async function mcpHandshakeEra() {
  const s = server();
  try {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert(init.result.protocolVersion === '2025-06-18', 'speaks the version the client asked for');
    assert(init.result.serverInfo.version === version, `reports AnimStudio's version (${init.result.serverInfo.version})`);
    assert(/analyze_clip/.test(init.result.instructions), 'instructions mention analyze_clip');
    const future = await s.request('initialize', { protocolVersion: '2099-01-01' });
    assert(future.result.protocolVersion === '2025-11-25', `an unknown version gets the newest handshake version (${future.result.protocolVersion})`);
    s.notify('notifications/initialized');
    const list = await s.request('tools/list', {});
    const tools = list.result.tools;
    assert(new Set(tools.map((t) => t.name)).size === tools.length, `${tools.length} tools, unique names`);
    // Every tool has a handler in the browser bridge (src/app/bridge.js) that carries it out.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'bridge.js'), 'utf8');
    const handlers = new Set([...src.slice(src.indexOf('const H = {')).matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]));
    const orphans = tools.map((t) => t.name).filter((n) => !handlers.has(n));
    assert(!orphans.length, `tools without a bridge handler: ${orphans.join(', ')}`);
    for (const t of tools) assert(t.title && t.annotations && typeof t.annotations.readOnlyHint === 'boolean' && t.annotations.openWorldHint === false, `${t.name}: title and hints`);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert(byName.status.annotations.readOnlyHint && byName.analyze_clip.annotations.readOnlyHint && byName.snapshot.annotations.readOnlyHint, 'looking is read-only');
    assert(!byName.delete_clip.annotations.readOnlyHint && byName.delete_clip.annotations.destructiveHint, 'deleting is destructive');
    assert(!list.result.resultType, 'no resultType in the handshake era');
    const call = await s.request('tools/call', { name: 'status', arguments: {} });
    assert(call.result.isError && /not running/i.test(call.result.content[0].text), 'a tool call without AnimStudio says how to start it');
    const unknown = await s.request('tools/call', { name: 'nope', arguments: {} });
    assert(unknown.error?.code === -32602, 'unknown tool is a protocol error');
    const missing = await s.request('frobnicate', {});
    assert(missing.error?.code === -32601, 'unknown method');
  } finally {
    s.close();
  }
}

export async function mcpPerRequestEra() {
  const s = server();
  try {
    const d = await s.request('server/discover', modern());
    assert(d.result.resultType === 'complete' && d.result.supportedVersions.includes('2026-07-28'), 'discover lists the per-request version');
    assert(d.result._meta['io.modelcontextprotocol/serverInfo'].name === 'animstudio', 'discover names the server');
    const list = await s.request('tools/list', modern());
    assert(list.result.resultType === 'complete' && list.result.tools.some((t) => t.name === 'analyze_clip'), 'tools/list in the per-request era');
    const ping = await s.request('ping', modern());
    assert(ping.result.resultType === 'complete', 'ping');
    const old = await s.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } });
    assert(old.error?.code === -32022 && old.error.data.supported.includes('2026-07-28'), 'unsupported version lists the supported ones');
  } finally {
    s.close();
  }
}

export async function versionIsTheSameEverywhere() {
  const { VERSION } = await import('../src/version.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).version;
  assert(VERSION === pkg && lock === pkg, `src/version.js ${VERSION}, package.json ${pkg}, package-lock.json ${lock}`);
}
