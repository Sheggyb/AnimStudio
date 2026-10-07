// "My library": the user's own standard moves, stored on the AnimStudio standard skeleton in
// AnimStudio/library/*.move.json. Independent of the reference models once built.
import { api } from './api.js';
import { loadAnimSource } from './animsource.js';
import { standardRig, averageClips, STANDARD_RIG_ID } from '../core/standard.js';
import { retargetClip } from '../core/retarget.js';
import { applyStyle, isDefaultStyle } from '../core/style.js';
import { serializeClip, deserializeClip } from '../core/clip.js';

export const MOVE_FORMAT = 'animstudio.move';
export const fileFor = (key) => `${String(key).replace(/[^\w.\- ()]/g, '_')}.move.json`;

const cache = new Map();

export async function listLibrary() {
  try {
    return (await api.library()).moves.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch {
    return [];
  }
}

/** Load a library move: { data, clip } where clip lives on the standard rig. */
export async function loadMove(file) {
  if (cache.has(file)) return cache.get(file);
  const data = await api.libraryLoad(file);
  if (data.format !== MOVE_FORMAT) throw new Error('Not an AnimStudio move file');
  const clip = deserializeClip(data.clip);
  const out = { data, clip };
  cache.set(file, out);
  return out;
}

export async function saveMove({ key, title, category, clip, sources = [], params = null, note = '' }) {
  const file = fileFor(key);
  const data = {
    format: MOVE_FORMAT,
    version: 1,
    rig: STANDARD_RIG_ID,
    name: title,
    key,
    category,
    note,
    sources,
    params,
    saved: new Date().toISOString(),
    clip: serializeClip({ ...clip, name: title }),
  };
  await api.librarySave(file, data);
  cache.delete(file);
  return file;
}

export async function deleteMove(file) {
  await api.libraryDelete(file);
  cache.delete(file);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Build one standard move from several reference styles: each style is retargeted onto the
 * standard skeleton, phase-aligned and averaged, then the optional slider style is applied.
 */
export async function buildStandardMove(move, variants, { params = null, onProgress = null } = {}) {
  const std = standardRig();
  const clips = [];
  for (const [k, v] of variants.entries()) {
    onProgress?.(k, variants.length, v);
    await tick();
    const src = await loadAnimSource(v.url, v.model);
    const c = src.byName.get(v.clip);
    if (c && c.duration > 0) clips.push(retargetClip(c, src.rig, std, { mode: 'auto', name: move.key }).clip);
  }
  if (!clips.length) throw new Error('No usable styles');
  let out = averageClips(clips, std, { name: move.key });
  if (params && !isDefaultStyle(params)) out = applyStyle(out, std, params);
  out.name = move.key;
  return { clip: out, used: clips.length };
}

/** A library move (standard rig) adapted to a character's skeleton. */
export function moveOnCharacter(stdClip, rig, name) {
  return retargetClip(stdClip, standardRig(), rig, { mode: 'auto', name }).clip;
}

export { standardRig };
