// Animation packs: GLB files full of animations in AnimStudio/animations (e.g. the Quaternius
// Universal Animation Library). They feed the Move Maker; every move retargets to any character.

const DIR = '/animations/';

/** Pack files: from the server listing when available, else animations/index.json. */
export async function listPacks() {
  let files = null;
  try {
    const r = await fetch('/api/animpacks');
    if (r.ok) files = (await r.json()).packs;
  } catch {}
  if (!files) {
    try {
      files = (await (await fetch(DIR + 'index.json', { cache: 'no-store' })).json()).packs;
    } catch {
      files = [];
    }
  }
  return files.map((f) => (typeof f === 'string' ? { name: f } : f)).map((f) => ({ ...f, url: DIR + encodeURIComponent(f.name), label: f.label || f.name.replace(/\.(glb|gltf)$/i, '') }));
}

/** Clip names + durations and skeleton bone names from a GLB's JSON chunk (no geometry decoding). */
export function glbInfo(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a .glb file');
  const len = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  const clips = (json.animations || []).map((a) => {
    let duration = 0;
    for (const s of a.samplers || []) duration = Math.max(duration, json.accessors?.[s.input]?.max?.[0] || 0);
    return { name: a.name || 'clip', duration };
  });
  const joints = json.skins?.[0]?.joints || [];
  return { clips, joints: joints.length, bones: joints.map((i) => json.nodes[i]?.name || '') };
}

async function glbClips(url) {
  return glbInfo(await (await fetch(url)).arrayBuffer());
}

let cached = null;
/** [{ model, url, label, clips:[{name, duration}] }] for every pack (cached per session). */
export function packSources({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  cached = (async () => {
    const out = [];
    for (const p of await listPacks()) {
      try {
        const info = await glbClips(p.url);
        if (info.clips.length && info.joints) out.push({ model: p.name, url: p.url, label: p.label, ...info });
      } catch (e) {
        console.warn('Animation pack', p.name, e);
      }
    }
    return out;
  })();
  cached.catch(() => (cached = null));
  return cached;
}
