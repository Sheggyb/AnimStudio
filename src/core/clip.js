// Clip / layer data model.
//
// Clip  = { id, name, duration, loop, layers: Layer[], events: {t, name}[], meta }
// Layer = { id, name, mode: 'base'|'additive'|'override', weight, mute, mask: string[]|null,
//           tracks: { [boneName]: { rot?, pos?, scl? } } }
//
// Clips are treated as immutable once committed: edits clone the clip (copy-on-write), which
// makes undo/redo a matter of swapping array references.
import * as THREE from 'three';
import { makeChannel, cloneChannel, STRIDE, LINEAR, STEP, resampleChannel, frameTimes, mergeTimes, isConstant, KEY_EPS } from './channel.js';

export const uid = (prefix = 'id') => prefix + Math.random().toString(36).slice(2, 10);

export const TYPES = ['rot', 'pos', 'scl'];
export const TYPE_TO_PROP = { rot: 'quaternion', pos: 'position', scl: 'scale' };
const PROP_TO_TYPE = { quaternion: 'rot', position: 'pos', scale: 'scl' };

export function makeLayer(name = 'Base', mode = 'base') {
  return { id: uid('L'), name, mode, weight: 1, mute: false, mask: null, tracks: {} };
}

export function makeClip(name = 'New clip', duration = 1) {
  return { id: uid('C'), name, duration, loop: false, layers: [makeLayer('Base', 'base')], events: [], meta: { source: 'new' } };
}

export function cloneTracks(tracks) {
  const out = {};
  for (const bone in tracks) {
    const t = tracks[bone];
    const o = (out[bone] = {});
    for (const k in t) if (t[k]) o[k] = cloneChannel(t[k]);
  }
  return out;
}

export function cloneLayer(l, newId = false) {
  return { ...l, id: newId ? uid('L') : l.id, mask: l.mask ? [...l.mask] : null, tracks: cloneTracks(l.tracks) };
}

/** Deep copy. `newId` gives the copy a fresh identity (for duplicates). */
export function cloneClip(c, newId = false) {
  return {
    ...c,
    id: newId ? uid('C') : c.id,
    layers: c.layers.map((l) => cloneLayer(l, newId)),
    events: c.events.map((e) => ({ ...e })),
    meta: { ...c.meta },
  };
}

export const layerIndex = (clip, layerId) => Math.max(0, clip.layers.findIndex((l) => l.id === layerId));
export const getLayer = (clip, layerId) => clip.layers.find((l) => l.id === layerId) || clip.layers[0];

export function getTrack(layer, bone, type, create = false) {
  let t = layer.tracks[bone];
  if (!t) {
    if (!create) return null;
    t = layer.tracks[bone] = {};
  }
  if (!t[type] && create) t[type] = makeChannel(type);
  return t[type] || null;
}

/** Remove empty channels/tracks from a layer. */
export function pruneLayer(layer) {
  for (const bone in layer.tracks) {
    const t = layer.tracks[bone];
    for (const k of TYPES) if (t[k] && t[k].times.length === 0) delete t[k];
    if (!t.rot && !t.pos && !t.scl) delete layer.tracks[bone];
  }
  return layer;
}

export function forEachChannel(layer, fn, bones = null) {
  for (const bone in layer.tracks) {
    if (bones && !bones.has(bone)) continue;
    const t = layer.tracks[bone];
    for (const k of TYPES) if (t[k]) fn(t[k], bone, k);
  }
}

/** Sorted unique key times in a layer (optionally only for some bones). */
export function layerKeyTimes(layer, bones = null) {
  const lists = [];
  forEachChannel(layer, (ch) => lists.push(ch.times), bones);
  return mergeTimes(...lists);
}

export function boneKeyTimes(layer, bone) {
  const t = layer.tracks[bone];
  if (!t) return [];
  return mergeTimes(...TYPES.filter((k) => t[k]).map((k) => t[k].times));
}

export function clipKeyCount(clip) {
  let n = 0;
  for (const l of clip.layers) forEachChannel(l, (ch) => (n += ch.times.length));
  return n;
}

// ---------------------------------------------------------------------------
// three.js interop
// ---------------------------------------------------------------------------

/** Convert a THREE.AnimationClip (from GLTFLoader) into a clip with one base layer. */
export function clipFromThree(tc, boneNames, opts = {}) {
  const clip = makeClip(tc.name || 'clip', Math.max(0, tc.duration));
  clip.meta = { source: opts.source || 'original', original: opts.source === undefined || opts.source === 'original' };
  const base = clip.layers[0];
  for (const tr of tc.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const bone = tr.name.slice(0, dot);
    const type = PROP_TO_TYPE[tr.name.slice(dot + 1)];
    if (!type || !boneNames.has(bone)) continue;
    const s = STRIDE[type];
    let ch;
    if (tr.values.length !== tr.times.length * s) {
      // Cubic-spline (or otherwise custom) track: resample through its own interpolant.
      const times = mergeTimes(Array.from(tr.times), frameTimes(tr.times[0], tr.times[tr.times.length - 1], 30));
      const it = tr.createInterpolant();
      const values = new Float32Array(times.length * s);
      times.forEach((t, k) => values.set(it.evaluate(t), k * s));
      ch = makeChannel(type, times, values, LINEAR);
    } else {
      const interp = tr.getInterpolation() === THREE.InterpolateDiscrete ? STEP : LINEAR;
      ch = makeChannel(type, tr.times, tr.values, interp);
    }
    (base.tracks[bone] ||= {})[type] = ch;
  }
  if (tc.userData?.events) clip.events = tc.userData.events.map((e) => ({ t: +e.t || 0, name: String(e.name || 'event') }));
  return clip;
}

/** Sorted list of bone names in hierarchy order (parents first) from a rig. */
const order = (rig) => rig.order.map((i) => rig.bones[i].name);

/**
 * Bake a clip (all layers, any interpolation) to a THREE.AnimationClip with LINEAR tracks.
 * Channels that are already plain linear base-layer data are copied exactly.
 */
export function bakeToThree(clip, rig, evalBone, { fps = 30, reduce = 0, reducer = null } = {}) {
  const tracks = [];
  const active = clip.layers.filter((l, i) => i === 0 || !l.mute);
  const grid = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const tmp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  for (const bone of order(rig)) {
    const idx = rig.byName.get(bone);
    const rest = rig.rest[idx];
    const layers = active.filter((l) => l.tracks[bone] && (!l.mask || l.mask.includes(bone)));
    if (!layers.length) continue;
    for (const type of TYPES) {
      const involved = layers.filter((l) => l.tracks[bone][type]);
      if (!involved.length) continue;
      const base = involved[0];
      const ch0 = base.tracks[bone][type];
      let times, values;
      const exact = involved.length === 1 && base.mode === 'base' && ch0.interp.every((m) => m === LINEAR);
      if (exact) {
        const keep = [];
        for (let i = 0; i < ch0.times.length; i++) if (ch0.times[i] <= clip.duration + KEY_EPS) keep.push(i);
        times = keep.map((i) => ch0.times[i]);
        const s = STRIDE[type];
        values = new Float32Array(keep.length * s);
        keep.forEach((i, k) => values.set(ch0.values.subarray(i * s, (i + 1) * s), k * s));
        if (!times.length) continue;
      } else {
        times = mergeTimes(grid, ...involved.map((l) => Array.from(l.tracks[bone][type].times).filter((t) => t <= clip.duration + KEY_EPS)));
        const s = STRIDE[type];
        values = new Float32Array(times.length * s);
        times.forEach((t, k) => {
          evalBone(clip, bone, t, rest, tmp);
          const v = type === 'rot' ? tmp.q : type === 'pos' ? tmp.p : tmp.s;
          v.toArray(values, k * s);
        });
      }
      let ch = makeChannel(type, times, values, LINEAR);
      if (reduce > 0 && reducer) ch = reducer(ch, reduce);
      const name = `${bone}.${TYPE_TO_PROP[type]}`;
      const T = type === 'rot' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      tracks.push(new T(name, ch.times, ch.values));
    }
  }
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  if (clip.events.length) out.userData = { events: clip.events.map((e) => ({ t: +e.t.toFixed(4), name: e.name })) };
  return out;
}

// ---------------------------------------------------------------------------
// Serialization (project files / clip JSON)
// ---------------------------------------------------------------------------
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function serChannel(c) {
  const allSame = c.interp.every((m) => m === c.interp[0]);
  return { t: Array.from(c.times, r6), v: Array.from(c.values, r6), i: allSame ? c.interp[0] || 0 : Array.from(c.interp) };
}
function deChannel(type, j) {
  const n = j.t.length;
  return makeChannel(type, j.t, j.v, Array.isArray(j.i) ? j.i : new Uint8Array(n).fill(j.i || 0));
}

export function serializeClip(c) {
  return {
    id: c.id,
    name: c.name,
    duration: r6(c.duration),
    loop: !!c.loop,
    events: c.events,
    meta: { source: c.meta?.source, sourceName: c.meta?.sourceName, note: c.meta?.note, originalName: c.meta?.originalName, recipe: c.meta?.recipe || undefined, generator: c.meta?.generator || undefined },
    layers: c.layers.map((l) => ({
      id: l.id,
      name: l.name,
      mode: l.mode,
      weight: l.weight,
      mute: l.mute,
      mask: l.mask,
      tracks: Object.fromEntries(
        Object.entries(l.tracks).map(([bone, t]) => [bone, Object.fromEntries(TYPES.filter((k) => t[k]).map((k) => [k, serChannel(t[k])]))])
      ),
    })),
  };
}

export function deserializeClip(j) {
  const c = makeClip(j.name, j.duration);
  c.id = j.id || c.id;
  c.loop = !!j.loop;
  c.events = (j.events || []).map((e) => ({ t: +e.t, name: String(e.name) }));
  c.meta = { ...(j.meta || {}), source: j.meta?.source || 'imported' };
  c.layers = (j.layers || []).map((lj) => {
    const l = makeLayer(lj.name, lj.mode);
    Object.assign(l, { id: lj.id || l.id, weight: lj.weight ?? 1, mute: !!lj.mute, mask: lj.mask || null });
    for (const bone in lj.tracks) {
      l.tracks[bone] = {};
      for (const k of TYPES) if (lj.tracks[bone][k]) l.tracks[bone][k] = deChannel(k, lj.tracks[bone][k]);
    }
    return l;
  });
  if (!c.layers.length) c.layers = [makeLayer()];
  c.layers[0].mode = 'base';
  return c;
}

/** Drop channels that never move away from the rest pose (saves space, declutters). */
export function stripStaticChannels(clip, rig, tol = 1e-5) {
  const base = clip.layers[0];
  for (const bone in base.tracks) {
    const t = base.tracks[bone];
    const r = rig.rest[rig.byName.get(bone)];
    if (!r) continue;
    for (const k of TYPES) {
      const ch = t[k];
      if (!ch || !isConstant(ch, tol)) continue;
      const restV = k === 'rot' ? r.q.toArray() : k === 'pos' ? r.p.toArray() : r.s.toArray();
      const s = STRIDE[k];
      let same = true;
      if (s === 4) same = 1 - Math.abs(restV[0] * ch.values[0] + restV[1] * ch.values[1] + restV[2] * ch.values[2] + restV[3] * ch.values[3]) < tol;
      else for (let i = 0; i < 3; i++) if (Math.abs(restV[i] - ch.values[i]) > tol) same = false;
      if (same) delete t[k];
    }
  }
  pruneLayer(base);
  return clip;
}

export { resampleChannel };
