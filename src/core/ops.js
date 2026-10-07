// Clip operations ("modifiers"). Every op mutates the clip it is given (callers pass a draft
// copy) and works within a scope:
//   ctx = { rig, li: layer index, bones: Set<boneName> | null, range: [t0, t1] | null, fps }
import * as THREE from 'three';
import {
  STRIDE,
  LINEAR,
  SMOOTH,
  KEY_EPS,
  sample,
  setKey,
  pickKeys,
  makeChannel,
  cloneChannel,
  frameTimes,
  mergeTimes,
  makeQuatsContinuous,
  resampleChannel,
  findKey,
} from './channel.js';
import { forEachChannel, getTrack, pruneLayer, makeClip, makeLayer, cloneClip, TYPES } from './clip.js';
import { evalBone, applyPose, makeXform } from './evaluate.js';
import { mirrorLocalRot, mirrorLocalPos, mirrorIndex, makeScratchSkeleton } from './rig.js';
import { solveTwoBone, bendHintFor } from './ik.js';
import { keyBone } from './keying.js';

const DEG = Math.PI / 180;
const EPS = KEY_EPS;
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const mod = (a, n) => ((a % n) + n) % n;
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const ID = new THREE.Quaternion();

export function rangeOf(clip, ctx) {
  if (!ctx?.range) return [0, clip.duration];
  return [Math.max(0, Math.min(ctx.range[0], ctx.range[1])), Math.min(clip.duration, Math.max(ctx.range[0], ctx.range[1]))];
}
const isFull = (clip, ctx) => {
  const [a, b] = rangeOf(clip, ctx);
  return a <= EPS && b >= clip.duration - EPS;
};
const layerOf = (clip, ctx) => clip.layers[ctx?.li ?? 0] || clip.layers[0];
const inRange = (t, a, b) => t >= a - EPS && t <= b + EPS;

function eachChannel(clip, ctx, fn, types = TYPES) {
  forEachChannel(layerOf(clip, ctx), (ch, bone, type) => types.includes(type) && fn(ch, bone, type), ctx?.bones || null);
}

/** q^f for a unit quaternion (rotation angle scaled by f). */
export function qPow(q, f, out = new THREE.Quaternion()) {
  let { x, y, z, w } = q;
  if (w < 0) [x, y, z, w] = [-x, -y, -z, -w];
  const half = Math.acos(Math.min(1, w));
  const s = Math.sin(half);
  if (s < 1e-9) return out.set(0, 0, 0, 1);
  const nh = half * f;
  const k = Math.sin(nh) / s;
  return out.set(x * k, y * k, z * k, Math.cos(nh));
}

function buildChannel(type, items) {
  // items: [{t, v: number[], i: interp}] -> channel (sorted, de-duplicated; later items win ties)
  items.sort((a, b) => a.t - b.t);
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - it.t) <= EPS) {
      if (it.prio >= (last.prio || 0)) out[out.length - 1] = it;
    } else out.push(it);
  }
  const ch = makeChannel(
    type,
    out.map((x) => x.t),
    out.flatMap((x) => Array.from(x.v)),
    out.map((x) => x.i ?? LINEAR)
  );
  if (type === 'rot') makeQuatsContinuous(ch.values);
  return ch;
}

const keyItems = (ch, filter = () => true) => {
  const s = STRIDE[ch.type];
  const out = [];
  for (let i = 0; i < ch.times.length; i++) {
    if (filter(ch.times[i], i)) out.push({ t: ch.times[i], v: Array.from(ch.values.subarray(i * s, (i + 1) * s)), i: ch.interp[i] });
  }
  return out;
};

// ===========================================================================
// Keys
// ===========================================================================

/** Even keys at `fps` inside the range (outside keys are kept). */
export function resample(clip, ctx, { fps = 10, smooth = true } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  const cycle = clip.loop ? clip.duration : 0;
  let before = 0,
    after = 0;
  eachChannel(clip, ctx, (ch) => {
    before += ch.times.length;
    if (ch.times.length >= 2) {
      const src = cloneChannel(ch);
      const grid = frameTimes(t0, t1, fps);
      const items = keyItems(src, (t) => !inRange(t, t0, t1));
      const s = STRIDE[ch.type];
      const tmp = new Float32Array(s);
      for (const t of grid) items.push({ t, v: Array.from(sample(src, t, tmp, cycle)), i: smooth ? SMOOTH : LINEAR, prio: 1 });
      const nc = buildChannel(ch.type, items);
      Object.assign(ch, nc);
    }
    after += ch.times.length;
  });
  return `Keys ${before} → ${after}`;
}

/** Angle (radians) between two quaternions stored in flat arrays; precise for tiny angles. */
export function quatAngle(a, ai, b, bi) {
  const [ax, ay, az, aw] = [a[ai], a[ai + 1], a[ai + 2], a[ai + 3]];
  const [bx, by, bz, bw] = [b[bi], b[bi + 1], b[bi + 2], b[bi + 3]];
  const rx = aw * bx - ax * bw - ay * bz + az * by;
  const ry = aw * by + ax * bz - ay * bw - az * bx;
  const rz = aw * bz - ax * by + ay * bx - az * bw;
  const rw = aw * bw + ax * bx + ay * by + az * bz;
  return 2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw));
}

function keyError(ch, a, b, i) {
  const ts = ch.times;
  const u = (ts[i] - ts[a]) / (ts[b] - ts[a] || 1);
  if (ch.type === 'rot') {
    const out = [0, 0, 0, 0];
    THREE.Quaternion.slerpFlat(out, 0, ch.values, a * 4, ch.values, b * 4, u);
    return quatAngle(out, 0, ch.values, i * 4);
  }
  let e = 0;
  for (let k = 0; k < 3; k++) {
    const va = ch.values[a * 3 + k],
      vb = ch.values[b * 3 + k];
    e += (va + (vb - va) * u - ch.values[i * 3 + k]) ** 2;
  }
  return Math.sqrt(e);
}

/** Douglas–Peucker key reduction: drops keys that linear interpolation reproduces within `tol`. */
export function reduceChannel(ch, tol, t0 = -Infinity, t1 = Infinity) {
  const n = ch.times.length;
  if (n <= 2) return ch;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  for (let i = 0; i < n; i++) if (!inRange(ch.times[i], t0, t1)) keep[i] = 1;
  const anchors = [];
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
  for (let k = 0; k + 1 < anchors.length; k++) {
    const stack = [[anchors[k], anchors[k + 1]]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      let maxE = 0,
        maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const e = keyError(ch, a, b, i);
        if (e > maxE) [maxE, maxI] = [e, i];
      }
      if (maxE > tol) {
        keep[maxI] = 1;
        stack.push([a, maxI], [maxI, b]);
      }
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  pickKeys(ch, idx);
  for (let i = 0; i < ch.times.length; i++) if (inRange(ch.times[i], t0, t1)) ch.interp[i] = LINEAR;
  return ch;
}

export function reduceKeys(clip, ctx, { angle = 0.5, distance = 0.002 } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  let before = 0,
    after = 0;
  eachChannel(clip, ctx, (ch) => {
    before += ch.times.length;
    reduceChannel(ch, ch.type === 'rot' ? angle * DEG : distance, t0, t1);
    after += ch.times.length;
  });
  return `Keys ${before} → ${after}`;
}

/** Remove channels whose keys never change (keeps a single key). */
export function removeStatic(clip, ctx) {
  let n = 0;
  eachChannel(clip, ctx, (ch) => {
    if (ch.times.length < 2) return;
    const s = STRIDE[ch.type];
    let same = true;
    for (let i = 1; i < ch.times.length && same; i++) {
      if (s === 4) {
        const d = Math.abs(
          ch.values[i * 4] * ch.values[0] + ch.values[i * 4 + 1] * ch.values[1] + ch.values[i * 4 + 2] * ch.values[2] + ch.values[i * 4 + 3] * ch.values[3]
        );
        same = 1 - d < 1e-7;
      } else for (let k = 0; k < 3; k++) if (Math.abs(ch.values[i * 3 + k] - ch.values[k]) > 1e-6) same = false;
    }
    if (same) {
      n += ch.times.length - 1;
      pickKeys(ch, [0]);
    }
  });
  return `Removed ${n} redundant keys`;
}

export function setInterpolation(clip, ctx, { mode = SMOOTH } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  eachChannel(clip, ctx, (ch) => {
    for (let i = 0; i < ch.times.length; i++) if (inRange(ch.times[i], t0, t1)) ch.interp[i] = mode;
  });
}

// ===========================================================================
// Motion
// ===========================================================================

/** Gaussian smoothing over dense samples. radius in frames. */
export function smooth(clip, ctx, { radius = 2, fps = 30 } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  const cyclic = clip.loop && isFull(clip, ctx);
  const grid = frameTimes(0, clip.duration, fps);
  const N = grid.length;
  const R = Math.max(1, Math.ceil(radius));
  const sigma = Math.max(0.5, radius / 2);
  const w = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  eachChannel(clip, ctx, (ch) => {
    if (ch.times.length < 3 || N < 3) return;
    const s = STRIDE[ch.type];
    const vals = [];
    const tmp = new Float32Array(s);
    const src = cloneChannel(ch);
    for (const t of grid) vals.push(Array.from(sample(src, t, tmp, clip.loop ? clip.duration : 0)));
    if (s === 4) for (let j = 1; j < N; j++) if (vals[j].reduce((a, x, k) => a + x * vals[j - 1][k], 0) < 0) vals[j] = vals[j].map((x) => -x);
    const items = keyItems(src, (t) => !inRange(t, t0, t1));
    for (let j = 0; j < N; j++) {
      if (!inRange(grid[j], t0, t1)) continue;
      const acc = new Array(s).fill(0);
      let ws = 0;
      for (let k = -R; k <= R; k++) {
        let jj = j + k;
        if (cyclic) jj = mod(jj, N - 1);
        else jj = Math.min(N - 1, Math.max(0, jj));
        const v = vals[jj];
        // keep hemisphere consistent with the centre sample
        const flip = s === 4 && v.reduce((a, x, q) => a + x * vals[j][q], 0) < 0 ? -1 : 1;
        for (let q = 0; q < s; q++) acc[q] += v[q] * flip * w[k + R];
        ws += w[k + R];
      }
      for (let q = 0; q < s; q++) acc[q] /= ws;
      if (s === 4) {
        const l = Math.hypot(...acc) || 1;
        for (let q = 0; q < 4; q++) acc[q] /= l;
      }
      items.push({ t: grid[j], v: acc, i: LINEAR, prio: 1 });
    }
    Object.assign(ch, buildChannel(ch.type, items));
  });
}

function restValue(ctx, bone, type, layerMode) {
  if (layerMode === 'additive') return type === 'rot' ? [0, 0, 0, 1] : type === 'pos' ? [0, 0, 0] : [1, 1, 1];
  const r = ctx.rig.rest[ctx.rig.byName.get(bone)];
  return type === 'rot' ? r.q.toArray() : type === 'pos' ? r.p.toArray() : r.s.toArray();
}

/** Scale motion around a pivot pose. factor > 1 exaggerates, < 1 dampens, 0 freezes at the pivot. */
export function amplify(clip, ctx, { factor = 1.5, pivot = 'mean', rotation = true, position = true, fps = 30 } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  const L = layerOf(clip, ctx);
  const types = [rotation && 'rot', position && 'pos'].filter(Boolean);
  eachChannel(
    clip,
    ctx,
    (ch, bone, type) => {
      const s = STRIDE[type];
      let pv;
      if (pivot === 'rest') pv = restValue(ctx, bone, type, L.mode);
      else if (pivot === 'first') pv = Array.from(sample(ch, t0, new Float32Array(s)));
      else {
        const grid = frameTimes(t0, t1, fps);
        const tmp = new Float32Array(s);
        const acc = new Array(s).fill(0);
        let ref = null;
        for (const t of grid) {
          const v = sample(ch, t, tmp);
          const flip = s === 4 && ref && v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2] + v[3] * ref[3] < 0 ? -1 : 1;
          if (!ref) ref = Array.from(v);
          for (let k = 0; k < s; k++) acc[k] += v[k] * flip;
        }
        if (s === 4) {
          const l = Math.hypot(...acc) || 1;
          pv = acc.map((x) => x / l);
        } else pv = acc.map((x) => x / grid.length);
      }
      if (s === 4) {
        const P = new THREE.Quaternion().fromArray(pv);
        const Pi = P.clone().invert();
        for (let i = 0; i < ch.times.length; i++) {
          if (!inRange(ch.times[i], t0, t1)) continue;
          _qa.fromArray(ch.values, i * 4);
          _qb.copy(Pi).multiply(_qa);
          qPow(_qb, factor, _qc);
          _qa.copy(P).multiply(_qc).normalize().toArray(ch.values, i * 4);
        }
        makeQuatsContinuous(ch.values);
      } else {
        for (let i = 0; i < ch.times.length; i++) {
          if (!inRange(ch.times[i], t0, t1)) continue;
          for (let k = 0; k < 3; k++) ch.values[i * 3 + k] = pv[k] + (ch.values[i * 3 + k] - pv[k]) * factor;
        }
      }
    },
    types
  );
}

// Deterministic smooth value noise in [-1, 1].
function hash(i) {
  let h = Math.imul(i | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
function vnoise(seed, x, period = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = period ? mod(i, period) : i;
  const b = period ? mod(i + 1, period) : i + 1;
  const u = f * f * (3 - 2 * f);
  const ha = hash(a * 7919 + seed * 104729);
  const hb = hash(b * 7919 + seed * 104729);
  return ha + (hb - ha) * u;
}
function fbm(seed, x, period) {
  return vnoise(seed, x, period) * 0.7 + vnoise(seed + 17, x * 2, period * 2) * 0.3;
}
const strHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Add organic wobble (breathing, nervousness, hand-held feel). amount in degrees, frequency in Hz. */
export function addNoise(clip, ctx, { amount = 3, frequency = 1.5, seed = 1, fps = 30 } = {}) {
  const rig = ctx.rig;
  const L = layerOf(clip, ctx);
  const [t0, t1] = rangeOf(clip, ctx);
  const full = isFull(clip, ctx);
  const period = clip.loop && full && clip.duration > 0 ? Math.max(1, Math.round(clip.duration * frequency)) : 0;
  const names = ctx.bones ? [...ctx.bones] : [...rig.core].map((i) => rig.names[i]);
  const grid = frameTimes(t0, t1, fps);
  const ramp = Math.min(0.25, (t1 - t0) / 4);
  const e = new THREE.Euler();
  for (const bone of names) {
    if (!rig.byName.has(bone)) continue;
    let ch = getTrack(L, bone, 'rot', false);
    if (!ch) {
      ch = getTrack(L, bone, 'rot', true);
      setKey(ch, 0, restValue(ctx, bone, 'rot', L.mode));
    }
    const src = cloneChannel(ch);
    const items = keyItems(src, (t) => !inRange(t, t0, t1));
    const tmp = new Float32Array(4);
    const hs = strHash(bone) + seed * 7;
    for (const t of grid) {
      const x = period ? (t / clip.duration) * period : t * frequency;
      let amp = amount * DEG;
      if (!full) amp *= smoothstep((t - t0) / (ramp || 1)) * smoothstep((t1 - t) / (ramp || 1));
      e.set(fbm(hs, x, period) * amp, fbm(hs + 1, x, period) * amp, fbm(hs + 2, x, period) * amp);
      _qa.fromArray(sample(src, t, tmp, clip.loop ? clip.duration : 0));
      _qa.multiply(_qb.setFromEuler(e)).normalize();
      items.push({ t, v: _qa.toArray(), i: LINEAR, prio: 1 });
    }
    Object.assign(ch, buildChannel('rot', items));
  }
}

/** Delay (positive frames) or advance a set of bones: overlap / follow-through. */
export function timeOffset(clip, ctx, { frames = 2, fps = 30 } = {}) {
  const dt = frames / fps;
  const D = clip.duration;
  if (D <= 0) return;
  eachChannel(clip, ctx, (ch) => {
    if (ch.times.length < 2) return;
    const src = cloneChannel(ch);
    const s = STRIDE[ch.type];
    const tmp = new Float32Array(s);
    const items = [];
    for (const it of keyItems(src)) {
      let t = it.t + dt;
      if (clip.loop) t = mod(t, D);
      else if (t < -EPS || t > D + EPS) continue;
      items.push({ ...it, t, prio: 1 });
    }
    const srcTime = (t) => (clip.loop ? mod(t - dt, D) : Math.min(D, Math.max(0, t - dt)));
    items.push({ t: 0, v: Array.from(sample(src, srcTime(0), tmp)), i: LINEAR, prio: 0 });
    items.push({ t: D, v: Array.from(sample(src, clip.loop ? srcTime(0) : srcTime(D), tmp)), i: LINEAR, prio: 0 });
    Object.assign(ch, buildChannel(ch.type, items));
  });
}

/** Mirror the whole clip left <-> right. */
export function mirrorClip(clip, ctx) {
  const rig = ctx.rig;
  for (const L of clip.layers) {
    const isDelta = L.mode === 'additive';
    const out = {};
    for (const bone in L.tracks) {
      const i = rig.byName.get(bone);
      if (i === undefined) {
        out[bone] = L.tracks[bone];
        continue;
      }
      const dst = rig.names[mirrorIndex(rig, i)];
      const tr = L.tracks[bone];
      const nt = {};
      if (tr.rot) {
        nt.rot = cloneChannel(tr.rot);
        for (let k = 0; k < nt.rot.times.length; k++) {
          _qa.fromArray(nt.rot.values, k * 4);
          mirrorLocalRot(rig, i, _qa, _qb, isDelta).toArray(nt.rot.values, k * 4);
        }
        makeQuatsContinuous(nt.rot.values);
      }
      if (tr.pos) {
        nt.pos = cloneChannel(tr.pos);
        for (let k = 0; k < nt.pos.times.length; k++) {
          _va.fromArray(nt.pos.values, k * 3);
          mirrorLocalPos(rig, i, _va, _vb, isDelta).toArray(nt.pos.values, k * 3);
        }
      }
      if (tr.scl) nt.scl = cloneChannel(tr.scl);
      out[dst] = nt;
    }
    L.tracks = out;
    if (L.mask) L.mask = L.mask.map((b) => (rig.byName.has(b) ? rig.names[mirrorIndex(rig, rig.byName.get(b))] : b));
  }
}

/** Blend the last frames into the first pose so the clip loops seamlessly. */
export function loopFix(clip, ctx, { frames = 6, fps = 30 } = {}) {
  const D = clip.duration;
  if (D <= 0) return;
  const B = Math.min(D / 2, frames / fps);
  const tb = D - B;
  eachChannel(clip, ctx, (ch) => {
    if (!ch.times.length) return;
    const s = STRIDE[ch.type];
    const src = cloneChannel(ch);
    const v0 = sample(src, 0, new Float32Array(s));
    const vD = sample(src, D, new Float32Array(s));
    const items = keyItems(src, (t) => t < tb - EPS);
    const tmp = new Float32Array(s);
    for (const t of frameTimes(tb, D, fps)) {
      const w = smoothstep((t - tb) / B);
      const v = Array.from(sample(src, t, tmp));
      if (s === 4) {
        _qa.fromArray(vD).invert().multiply(_qb.fromArray(v0)); // vD^-1 * v0
        qPow(_qa, w, _qc);
        _qb.fromArray(v).multiply(_qc).normalize();
        items.push({ t, v: _qb.toArray(), i: LINEAR, prio: 1 });
      } else items.push({ t, v: v.map((x, k) => x + (v0[k] - vD[k]) * w), i: LINEAR, prio: 1 });
    }
    Object.assign(ch, buildChannel(ch.type, items));
  });
  clip.loop = true;
}

/** Root motion: 'inplace' locks horizontal movement, 'drift' removes only the net travel. */
export function rootMotion(clip, ctx, { mode = 'inplace' } = {}) {
  const rig = ctx.rig;
  const axes = [rig.lateral === 'x' ? 0 : 2, rig.forwardAxis === 'x' ? 0 : 2];
  const L = clip.layers[0];
  const D = clip.duration || 1;
  let n = 0;
  for (const idx of [rig.special.root, rig.special.hips]) {
    if (idx == null || idx < 0) continue;
    const ch = L.tracks[rig.names[idx]]?.pos;
    if (!ch || !ch.times.length) continue;
    n++;
    const first = Array.from(ch.values.subarray(0, 3));
    const last = Array.from(ch.values.subarray((ch.times.length - 1) * 3));
    for (let i = 0; i < ch.times.length; i++) {
      for (const a of axes) {
        if (mode === 'inplace') ch.values[i * 3 + a] = first[a];
        else ch.values[i * 3 + a] -= (last[a] - first[a]) * (ch.times[i] / D);
      }
    }
  }
  return n ? 'Root motion updated' : 'No root/hips position keys in this clip';
}

// ===========================================================================
// Timing (whole clip, all layers)
// ===========================================================================
function allChannels(clip, fn) {
  for (const L of clip.layers) forEachChannel(L, fn);
}

export function reverse(clip, ctx = {}) {
  const D = clip.duration;
  for (const L of clip.layers) {
    forEachChannel(
      L,
      (ch) => {
        const n = ch.times.length;
        const s = STRIDE[ch.type];
        const times = new Float32Array(n);
        const values = new Float32Array(n * s);
        const ip = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
          const o = n - 1 - k;
          times[k] = D - ch.times[o];
          values.set(ch.values.subarray(o * s, (o + 1) * s), k * s);
          ip[k] = k < n - 1 ? ch.interp[n - 2 - k] : ch.interp[n - 1];
        }
        Object.assign(ch, { times, values, interp: ip });
      },
      ctx.bones || null
    );
  }
  if (!ctx.bones) clip.events = clip.events.map((e) => ({ ...e, t: D - e.t })).sort((a, b) => a.t - b.t);
}

export function scaleTime(clip, factor) {
  if (!(factor > 0)) return;
  allChannels(clip, (ch) => (ch.times = Float32Array.from(ch.times, (t) => t * factor)));
  clip.duration *= factor;
  clip.events = clip.events.map((e) => ({ ...e, t: e.t * factor }));
}

export function setDuration(clip, duration, stretch = true) {
  if (!(duration > 0)) return;
  if (stretch && clip.duration > 0) scaleTime(clip, duration / clip.duration);
  else clip.duration = duration;
}

/** Keep only [t0, t1]; it becomes the whole clip. */
export function trim(clip, t0, t1) {
  if (!(t1 > t0)) return;
  allChannels(clip, (ch) => {
    const s = STRIDE[ch.type];
    const src = cloneChannel(ch);
    const items = keyItems(src, (t) => t > t0 + EPS && t < t1 - EPS).map((x) => ({ ...x, t: x.t - t0, prio: 1 }));
    items.push({ t: 0, v: Array.from(sample(src, t0, new Float32Array(s))), i: src.interp[Math.max(0, findKey(src, t0))] ?? LINEAR });
    items.push({ t: t1 - t0, v: Array.from(sample(src, t1, new Float32Array(s))), i: LINEAR });
    Object.assign(ch, buildChannel(ch.type, items));
  });
  clip.duration = t1 - t0;
  clip.events = clip.events.filter((e) => e.t >= t0 - EPS && e.t <= t1 + EPS).map((e) => ({ ...e, t: e.t - t0 }));
}

/**
 * Re-time motion with an easing curve inside the range (all layers, all bones): slow-in /
 * slow-out without changing the clip length. strength 0..1.
 */
export function easeTiming(clip, ctx, { mode = 'inout', strength = 0.6, fps = 30 } = {}) {
  const [t0, t1] = rangeOf(clip, ctx);
  const len = t1 - t0;
  if (len <= 0) return;
  const curve = {
    inout: (u) => u * u * (3 - 2 * u),
    in: (u) => u * u,
    out: (u) => 1 - (1 - u) * (1 - u),
  }[mode] || ((u) => u);
  const warp = (t) => {
    const u = (t - t0) / len;
    return t0 + len * (u + (curve(u) - u) * strength);
  };
  for (const L of clip.layers) {
    forEachChannel(L, (ch) => {
      if (ch.times.length < 2) return;
      const src = cloneChannel(ch);
      const s = STRIDE[ch.type];
      const tmp = new Float32Array(s);
      const items = keyItems(src, (t) => !inRange(t, t0, t1));
      for (const t of frameTimes(t0, t1, fps)) items.push({ t, v: Array.from(sample(src, warp(t), tmp, clip.loop ? clip.duration : 0)), i: LINEAR, prio: 1 });
      Object.assign(ch, buildChannel(ch.type, items));
    });
  }
}

/** Freeze the pose at `at` for `dur` seconds (everything after moves later). */
export function insertHold(clip, at, dur) {
  if (!(dur > 0)) return;
  allChannels(clip, (ch) => {
    const s = STRIDE[ch.type];
    const src = cloneChannel(ch);
    const v = Array.from(sample(src, at, new Float32Array(s)));
    const items = keyItems(src).map((x) => (x.t > at + EPS ? { ...x, t: x.t + dur } : x));
    items.push({ t: at, v, i: LINEAR, prio: 1 }, { t: at + dur, v, i: src.interp[Math.max(0, findKey(src, at))] ?? LINEAR, prio: 1 });
    Object.assign(ch, buildChannel(ch.type, items));
  });
  clip.duration += dur;
  clip.events = clip.events.map((e) => (e.t > at ? { ...e, t: e.t + dur } : e));
}

/** Cut [t0, t1] out of the clip. */
export function deleteRange(clip, t0, t1, fps = 30) {
  const cut = t1 - t0;
  if (!(cut > 0) || cut >= clip.duration - EPS) return;
  allChannels(clip, (ch) => {
    const s = STRIDE[ch.type];
    const src = cloneChannel(ch);
    const items = keyItems(src, (t) => t < t0 - EPS || t > t1 + EPS).map((x) => (x.t > t1 ? { ...x, t: x.t - cut } : x));
    const before = t0 - 1 / fps;
    if (before > EPS) items.push({ t: before, v: Array.from(sample(src, before, new Float32Array(s))), i: LINEAR });
    items.push({ t: t0, v: Array.from(sample(src, t1, new Float32Array(s))), i: LINEAR, prio: 1 });
    Object.assign(ch, buildChannel(ch.type, items));
  });
  clip.duration -= cut;
  clip.events = clip.events.filter((e) => e.t < t0 || e.t > t1).map((e) => (e.t > t1 ? { ...e, t: e.t - cut } : e));
}

// ===========================================================================
// Layers & combining clips
// ===========================================================================

function bonesWithTracks(clip, activeOnly = true) {
  const set = new Set();
  clip.layers.forEach((l, i) => {
    if (activeOnly && i > 0 && l.mute) return;
    for (const b in l.tracks) set.add(b);
  });
  return set;
}
function typesFor(clip, bone, activeOnly = true) {
  const set = new Set();
  clip.layers.forEach((l, i) => {
    if (activeOnly && i > 0 && l.mute) return;
    const t = l.tracks[bone];
    if (t) TYPES.forEach((k) => t[k] && set.add(k));
  });
  return [...set];
}
const pick = (x, type) => (type === 'rot' ? x.q : type === 'pos' ? x.p : x.s);

/** Merge all un-muted layers into a single base layer (muted layers are kept). */
export function bakeLayers(clip, ctx, { fps = 30 } = {}) {
  const rig = ctx.rig;
  const active = clip.layers.filter((l, i) => i === 0 || !l.mute);
  if (active.length <= 1) return 'Only one active layer — nothing to bake';
  const base = makeLayer('Base', 'base');
  const grid = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const x = makeXform();
  for (const bone of bonesWithTracks(clip)) {
    const i = rig.byName.get(bone);
    if (i === undefined) continue;
    for (const type of typesFor(clip, bone)) {
      const involved = active.filter((l) => l.tracks[bone]?.[type] && (!l.mask || l.mask.includes(bone)));
      if (!involved.length) continue;
      if (involved.length === 1 && involved[0] === clip.layers[0]) {
        (base.tracks[bone] ||= {})[type] = cloneChannel(involved[0].tracks[bone][type]);
        continue;
      }
      const times = mergeTimes(grid, ...involved.map((l) => Array.from(l.tracks[bone][type].times).filter((t) => t <= clip.duration + EPS)));
      const s = STRIDE[type];
      const values = new Float32Array(times.length * s);
      times.forEach((t, k) => {
        evalBone(clip, bone, t, rig.rest[i], x);
        pick(x, type).toArray(values, k * s);
      });
      (base.tracks[bone] ||= {})[type] = makeChannel(type, times, values, LINEAR);
    }
  }
  clip.layers = [base, ...clip.layers.filter((l, i) => i > 0 && l.mute)];
  return 'Layers baked into Base';
}

/**
 * Put another clip on top of this one as a new layer.
 * timing: 'stretch' (fit to this clip's length) | 'loop' (repeat) | 'asis'
 * mode 'additive' stores the source's motion relative to its first frame.
 */
export function addClipAsLayer(target, source, ctx, { mode = 'override', mask = null, weight = 1, timing = 'stretch', fps = 30, name = null } = {}) {
  const rig = ctx.rig;
  const Ds = source.duration;
  const Dt = target.duration;
  const L = makeLayer(name || source.name, mode);
  L.weight = weight;
  L.mask = mask && mask.length ? [...mask] : null;
  const maskSet = L.mask ? new Set(L.mask) : null;
  const x = makeXform();
  const ref = makeXform();
  for (const bone of bonesWithTracks(source)) {
    if (maskSet && !maskSet.has(bone)) continue;
    const i = rig.byName.get(bone);
    if (i === undefined) continue;
    const rest = rig.rest[i];
    let times;
    if (timing === 'loop' && Ds > 0) times = frameTimes(0, Dt, fps);
    else {
      const srcTimes = mergeTimes(...source.layers.map((l) => (l.tracks[bone] ? TYPES.flatMap((k) => (l.tracks[bone][k] ? Array.from(l.tracks[bone][k].times) : [])) : [])));
      const k = timing === 'stretch' && Ds > 0 ? Dt / Ds : 1;
      times = mergeTimes(srcTimes.map((t) => t * k).filter((t) => t <= Dt + EPS));
      if (!times.length) times = [0];
    }
    const srcTime = (t) => (timing === 'loop' && Ds > 0 ? mod(t, Ds) : timing === 'stretch' && Dt > 0 ? (t * Ds) / Dt : t);
    evalBone(source, bone, 0, rest, ref);
    for (const type of typesFor(source, bone)) {
      const s = STRIDE[type];
      const values = new Float32Array(times.length * s);
      times.forEach((t, k) => {
        evalBone(source, bone, srcTime(t), rest, x);
        if (mode === 'additive') {
          if (type === 'rot') _qa.copy(ref.q).invert().multiply(x.q).toArray(values, k * s);
          else if (type === 'pos') _va.copy(x.p).sub(ref.p).toArray(values, k * s);
          else _va.copy(x.s).divide(ref.s).toArray(values, k * s);
        } else pick(x, type).toArray(values, k * s);
      });
      (L.tracks[bone] ||= {})[type] = makeChannel(type, times, values, LINEAR);
    }
  }
  target.layers.push(L);
  return L;
}

function blendX(a, b, w, out) {
  out.q.copy(a.q).slerp(b.q, w);
  out.p.copy(a.p).lerp(b.p, w);
  out.s.copy(a.s).lerp(b.s, w);
  return out;
}

function denseClip(name, duration, rig, bones, evalAt, fps, reduceTol = 0.05) {
  const clip = makeClip(name, duration);
  const grid = duration > 0 ? frameTimes(0, duration, fps) : [0];
  const x = makeXform();
  for (const bone of bones) {
    const i = rig.byName.get(bone);
    if (i === undefined) continue;
    const vals = { rot: new Float32Array(grid.length * 4), pos: new Float32Array(grid.length * 3), scl: new Float32Array(grid.length * 3) };
    grid.forEach((t, k) => {
      evalAt(bone, i, t, x);
      x.q.toArray(vals.rot, k * 4);
      x.p.toArray(vals.pos, k * 3);
      x.s.toArray(vals.scl, k * 3);
    });
    const tr = {};
    for (const type of TYPES) {
      const ch = makeChannel(type, grid, vals[type], LINEAR);
      if (type === 'rot') makeQuatsContinuous(ch.values);
      reduceChannel(ch, type === 'rot' ? reduceTol * DEG : 0.0005);
      // skip channels that just sit at the rest pose
      const r = rig.rest[i];
      const rv = type === 'rot' ? r.q : type === 'pos' ? r.p : r.s;
      const atRest =
        ch.times.length <= 2 &&
        [...Array(ch.times.length).keys()].every((k) =>
          type === 'rot' ? 1 - Math.abs(_qa.fromArray(ch.values, k * 4).dot(rv)) < 1e-7 : _va.fromArray(ch.values, k * 3).distanceTo(rv) < 1e-6
        );
      if (!atRest) tr[type] = ch;
    }
    if (Object.keys(tr).length) clip.layers[0].tracks[bone] = tr;
  }
  return clip;
}

/** Play A then B with a crossfade of `blend` frames. */
export function concatClips(a, b, ctx, { blend = 6, fps = 30, name = null } = {}) {
  const rig = ctx.rig;
  const B = Math.min(blend / fps, a.duration, b.duration);
  const D = a.duration + b.duration - B;
  const start = a.duration - B;
  const bones = new Set([...bonesWithTracks(a), ...bonesWithTracks(b)]);
  const xa = makeXform(),
    xb = makeXform();
  const out = denseClip(
    name || `${a.name}+${b.name}`,
    D,
    rig,
    bones,
    (bone, i, t, x) => {
      const rest = rig.rest[i];
      if (t <= start) return evalBone(a, bone, t, rest, x);
      if (t >= a.duration) return evalBone(b, bone, t - start, rest, x);
      evalBone(a, bone, t, rest, xa);
      evalBone(b, bone, t - start, rest, xb);
      return blendX(xa, xb, smoothstep((t - start) / (B || 1)), x);
    },
    fps
  );
  out.loop = false;
  out.events = [...a.events, ...b.events.map((e) => ({ ...e, t: e.t + start }))];
  out.meta = { source: 'derived', note: `${a.name} → ${b.name}` };
  return out;
}

/** Blend two clips over normalised time (e.g. 50% walk + 50% run). */
export function blendClips(a, b, ctx, { weight = 0.5, fps = 30, name = null } = {}) {
  const rig = ctx.rig;
  const D = a.duration + (b.duration - a.duration) * weight;
  const bones = new Set([...bonesWithTracks(a), ...bonesWithTracks(b)]);
  const xa = makeXform(),
    xb = makeXform();
  const out = denseClip(
    name || `${a.name}×${b.name}`,
    D,
    rig,
    bones,
    (bone, i, t, x) => {
      const u = D > 0 ? t / D : 0;
      evalBone(a, bone, u * a.duration, rig.rest[i], xa);
      evalBone(b, bone, u * b.duration, rig.rest[i], xb);
      return blendX(xa, xb, weight, x);
    },
    fps
  );
  out.loop = a.loop && b.loop;
  out.meta = { source: 'derived', note: `blend ${a.name} / ${b.name} @ ${Math.round(weight * 100)}%` };
  return out;
}

/** New clip with keys only at the given key-pose times (smooth interpolation): pose-to-pose. */
export function keyPosesClip(clip, ctx, times, { name = null, interp = SMOOTH } = {}) {
  const rig = ctx.rig;
  const out = makeClip(name || `${clip.name}_keyposes`, clip.duration);
  out.loop = clip.loop;
  out.events = clip.events.map((e) => ({ ...e }));
  const x = makeXform();
  for (const bone of bonesWithTracks(clip)) {
    const i = rig.byName.get(bone);
    if (i === undefined) continue;
    for (const type of typesFor(clip, bone)) {
      const s = STRIDE[type];
      const values = new Float32Array(times.length * s);
      times.forEach((t, k) => {
        evalBone(clip, bone, t, rig.rest[i], x);
        pick(x, type).toArray(values, k * s);
      });
      const ch = makeChannel(type, times, values, interp);
      if (type === 'rot') makeQuatsContinuous(ch.values);
      (out.layers[0].tracks[bone] ||= {})[type] = ch;
    }
  }
  out.meta = { source: 'derived', note: `key poses of ${clip.name}` };
  return out;
}

// ===========================================================================
// IK-based fixes
// ===========================================================================

/** Plant feet: keep each foot where it is at the start of the range, solving leg IK per frame. */
export function lockFeet(clip, ctx, { sides = ['L', 'R'], fps = 30 } = {}) {
  const rig = ctx.rig;
  const [t0, t1] = rangeOf(clip, ctx);
  const li = ctx.li ?? 0;
  const orig = cloneClip(clip);
  const sk = makeScratchSkeleton(rig);
  applyPose(orig, t0, rig, sk.bones);
  sk.root.updateMatrixWorld(true);
  const legs = sides
    .map((s) => rig.ik[`foot.${s}`])
    .filter(Boolean)
    .map((ik) => ({
      ik,
      pos: sk.bones[ik.end].getWorldPosition(new THREE.Vector3()),
      quat: sk.bones[ik.end].getWorldQuaternion(new THREE.Quaternion()),
    }));
  if (!legs.length) return 'No legs found on this rig';
  const hint = bendHintFor(rig, 'forward');
  const pq = new THREE.Quaternion();
  for (const t of frameTimes(t0, t1, fps)) {
    applyPose(orig, t, rig, sk.bones);
    sk.root.updateMatrixWorld(true);
    for (const { ik, pos, quat } of legs) {
      const [u, l, e] = [sk.bones[ik.upper], sk.bones[ik.lower], sk.bones[ik.end]];
      solveTwoBone(u, l, e, pos, { bendHint: hint, keepEndRotation: false });
      e.parent.getWorldQuaternion(pq);
      e.quaternion.copy(pq.invert().multiply(quat));
      e.updateWorldMatrix(false, true);
      for (const b of [ik.upper, ik.lower, ik.end]) {
        const bone = sk.bones[b];
        keyBone(clip, li, rig.names[b], t, { p: bone.position, q: bone.quaternion, s: bone.scale }, rig.rest[b], { rot: true, pos: false, scl: false });
      }
    }
  }
  return `Feet locked from ${t0.toFixed(2)}s to ${t1.toFixed(2)}s`;
}

export { pruneLayer };
