// Keyframe channels: the smallest unit of animation data.
//
// A channel animates one property of one bone:
//   { type: 'rot' | 'pos' | 'scl', times: Float32Array, values: Float32Array, interp: Uint8Array }
// `interp[i]` is the interpolation of the segment that STARTS at key i.
// Rotations are quaternions (x, y, z, w); positions/scales are vec3.
import * as THREE from 'three';

export const LINEAR = 0;
export const SMOOTH = 1;
export const EASE = 2;
export const STEP = 3;
export const INTERP_NAMES = ['Linear', 'Smooth', 'Ease', 'Step'];
export const STRIDE = { rot: 4, pos: 3, scl: 3 };
export const KEY_EPS = 1e-4;

export function makeChannel(type, times = [], values = [], interp = null) {
  const n = times.length;
  return {
    type,
    times: Float32Array.from(times),
    values: Float32Array.from(values),
    interp: interp == null ? new Uint8Array(n) : typeof interp === 'number' ? new Uint8Array(n).fill(interp) : Uint8Array.from(interp),
  };
}

export function cloneChannel(c) {
  return { type: c.type, times: c.times.slice(), values: c.values.slice(), interp: c.interp.slice() };
}

export const keyCount = (c) => c.times.length;

export function getValue(c, i, out = []) {
  const s = STRIDE[c.type];
  for (let k = 0; k < s; k++) out[k] = c.values[i * s + k];
  return out;
}

/** Index of the key at time t (within eps), or -1. */
export function findKey(c, t, eps = KEY_EPS) {
  const ts = c.times;
  let lo = 0,
    hi = ts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = ts[mid] - t;
    if (Math.abs(d) <= eps) return mid;
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Index of the last key with time <= t, or -1 when t is before the first key. */
export function segmentIndex(ts, t) {
  let lo = 0,
    hi = ts.length - 1,
    r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) {
      r = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return r;
}

// Flip a quaternion into the same hemisphere as key `ref` so interpolation takes the short way.
function alignTo(c, v, ref) {
  if (ref < 0 || ref >= c.times.length) return v;
  const o = ref * 4;
  const d = v[0] * c.values[o] + v[1] * c.values[o + 1] + v[2] * c.values[o + 2] + v[3] * c.values[o + 3];
  return d < 0 ? [-v[0], -v[1], -v[2], -v[3]] : v;
}

/** Insert a key, or overwrite the key already at t. Returns the key index. Mutates c. */
export function setKey(c, t, value, interp = null, eps = KEY_EPS) {
  const s = STRIDE[c.type];
  let v = Array.from(value).slice(0, s);
  const existing = findKey(c, t, eps);
  if (existing >= 0) {
    if (c.type === 'rot') v = alignTo(c, v, existing > 0 ? existing - 1 : existing + 1);
    c.values.set(v, existing * s);
    if (interp != null) c.interp[existing] = interp;
    return existing;
  }
  const at = segmentIndex(c.times, t) + 1;
  if (c.type === 'rot') v = alignTo(c, v, at > 0 ? at - 1 : at);
  const n = c.times.length;
  const times = new Float32Array(n + 1);
  times.set(c.times.subarray(0, at));
  times[at] = t;
  times.set(c.times.subarray(at), at + 1);
  const values = new Float32Array((n + 1) * s);
  values.set(c.values.subarray(0, at * s));
  values.set(v, at * s);
  values.set(c.values.subarray(at * s), (at + 1) * s);
  const ip = new Uint8Array(n + 1);
  ip.set(c.interp.subarray(0, at));
  ip[at] = interp != null ? interp : n === 0 ? LINEAR : c.interp[Math.max(0, at - 1)];
  ip.set(c.interp.subarray(at), at + 1);
  c.times = times;
  c.values = values;
  c.interp = ip;
  return at;
}

/** Keep only the keys whose indices are listed (in ascending order). */
export function pickKeys(c, indices) {
  const s = STRIDE[c.type];
  const times = new Float32Array(indices.length);
  const values = new Float32Array(indices.length * s);
  const ip = new Uint8Array(indices.length);
  indices.forEach((i, k) => {
    times[k] = c.times[i];
    values.set(c.values.subarray(i * s, (i + 1) * s), k * s);
    ip[k] = c.interp[i];
  });
  c.times = times;
  c.values = values;
  c.interp = ip;
  return c;
}

export function removeKeys(c, indices) {
  const del = new Set(indices);
  const keep = [];
  for (let i = 0; i < c.times.length; i++) if (!del.has(i)) keep.push(i);
  return pickKeys(c, keep);
}

/** Remove keys with times inside [t0, t1]. */
export function removeKeysInRange(c, t0, t1, eps = KEY_EPS) {
  const keep = [];
  for (let i = 0; i < c.times.length; i++) if (c.times[i] < t0 - eps || c.times[i] > t1 + eps) keep.push(i);
  return pickKeys(c, keep);
}

/**
 * Re-time keys. `mapTime(t, i)` returns the new time for each listed index.
 * Unlisted keys that land on the same time as a moved key are dropped (moved keys win).
 */
export function retimeKeys(c, indices, mapTime, eps = KEY_EPS) {
  const s = STRIDE[c.type];
  const moving = new Set(indices);
  const items = [];
  for (let i = 0; i < c.times.length; i++) {
    items.push({ t: moving.has(i) ? mapTime(c.times[i], i) : c.times[i], i, m: moving.has(i) });
  }
  const movedTimes = items.filter((x) => x.m).map((x) => x.t);
  let list = items.filter((x) => x.m || !movedTimes.some((mt) => Math.abs(mt - x.t) <= eps));
  list.sort((a, b) => a.t - b.t || a.m - b.m);
  const out = [];
  for (const it of list) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - it.t) <= eps) out[out.length - 1] = it; // later (moved) wins
    else out.push(it);
  }
  const times = new Float32Array(out.length);
  const values = new Float32Array(out.length * s);
  const ip = new Uint8Array(out.length);
  out.forEach((it, k) => {
    times[k] = it.t;
    values.set(c.values.subarray(it.i * s, (it.i + 1) * s), k * s);
    ip[k] = c.interp[it.i];
  });
  c.times = times;
  c.values = values;
  c.interp = ip;
  return c;
}

export function shiftKeys(c, indices, dt, snap = (t) => t) {
  return retimeKeys(c, indices, (t) => snap(t + dt));
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
const P = [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)];

function copyKey(out, vs, i, s) {
  for (let k = 0; k < s; k++) out[k] = vs[i * s + k];
  return out;
}

// Slope at the middle point for monotone cubic ("auto-clamped") curves: flat at extremes,
// never overshoots, so poses hold where the animator put them.
function slope(a, b, c, ta, tb, tc) {
  if (a === null || c === null) return 0;
  const dl = (b - a) / (tb - ta || 1e-6);
  const dr = (c - b) / (tc - tb || 1e-6);
  if (dl * dr <= 0) return 0;
  const m = (c - a) / (tc - ta || 1e-6);
  const lim = 3 * Math.min(Math.abs(dl), Math.abs(dr));
  return Math.sign(m) * Math.min(Math.abs(m), lim);
}

function alignInto(dst, ref) {
  if (dst[0] * ref[0] + dst[1] * ref[1] + dst[2] * ref[2] + dst[3] * ref[3] < 0) {
    dst[0] = -dst[0];
    dst[1] = -dst[1];
    dst[2] = -dst[2];
    dst[3] = -dst[3];
  }
}

function smoothSample(c, i, u, out, cycle) {
  const ts = c.times;
  const vs = c.values;
  const n = ts.length;
  const s = STRIDE[c.type];
  const cyclic = cycle > 0 && n > 2 && Math.abs(ts[0]) < KEY_EPS && Math.abs(ts[n - 1] - cycle) < KEY_EPS;

  let tm1 = null,
    t2 = null;
  const [pm1, p0, p1, p2] = P;
  let hasM1 = false,
    has2 = false;
  copyKey(p0, vs, i, s);
  copyKey(p1, vs, i + 1, s);
  const t0 = ts[i],
    t1 = ts[i + 1];
  if (i > 0) {
    copyKey(pm1, vs, i - 1, s);
    tm1 = ts[i - 1];
    hasM1 = true;
  } else if (cyclic) {
    copyKey(pm1, vs, n - 2, s);
    tm1 = ts[n - 2] - cycle;
    hasM1 = true;
  }
  if (i + 2 < n) {
    copyKey(p2, vs, i + 2, s);
    t2 = ts[i + 2];
    has2 = true;
  } else if (cyclic) {
    copyKey(p2, vs, 1, s);
    t2 = ts[1] + cycle;
    has2 = true;
  }
  if (s === 4) {
    alignInto(p1, p0);
    if (hasM1) alignInto(pm1, p0);
    if (has2) alignInto(p2, p1);
  }
  const dt = t1 - t0;
  const u2 = u * u,
    u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1,
    h10 = u3 - 2 * u2 + u,
    h01 = -2 * u3 + 3 * u2,
    h11 = u3 - u2;
  for (let k = 0; k < s; k++) {
    const m0 = slope(hasM1 ? pm1[k] : null, p0[k], p1[k], tm1, t0, t1);
    const m1 = slope(p0[k], p1[k], has2 ? p2[k] : null, t0, t1, t2);
    out[k] = h00 * p0[k] + h10 * dt * m0 + h01 * p1[k] + h11 * dt * m1;
  }
  if (s === 4) {
    const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    for (let k = 0; k < 4; k++) out[k] /= l;
  }
  return out;
}

/**
 * Evaluate a channel at time t into `out` (array-like of length 3 or 4).
 * `cycle` > 0 makes smooth curves wrap around for looping clips.
 */
export function sample(c, t, out, cycle = 0) {
  const ts = c.times;
  const vs = c.values;
  const n = ts.length;
  const s = STRIDE[c.type];
  if (n === 0) return null;
  if (n === 1 || t <= ts[0]) return copyKey(out, vs, 0, s);
  if (t >= ts[n - 1]) return copyKey(out, vs, n - 1, s);
  const i = segmentIndex(ts, t);
  const dt = ts[i + 1] - ts[i];
  let u = dt > 0 ? (t - ts[i]) / dt : 0;
  const mode = c.interp[i];
  if (mode === STEP) return copyKey(out, vs, i, s);
  if (mode === SMOOTH) return smoothSample(c, i, u, out, cycle);
  if (mode === EASE) u = u * u * (3 - 2 * u);
  if (s === 4) THREE.Quaternion.slerpFlat(out, 0, vs, i * 4, vs, (i + 1) * 4, u);
  else for (let k = 0; k < 3; k++) out[k] = vs[i * 3 + k] + (vs[(i + 1) * 3 + k] - vs[i * 3 + k]) * u;
  return out;
}

/** Sample a channel on an arbitrary list of times; returns a new Float32Array of values. */
export function sampleMany(c, times, cycle = 0) {
  const s = STRIDE[c.type];
  const out = new Float32Array(times.length * s);
  const tmp = new Float32Array(s);
  times.forEach((t, k) => out.set(sample(c, t, tmp, cycle), k * s));
  return out;
}

/** Replace a channel's content with samples at `times` (linear interpolation afterwards). */
export function resampleChannel(c, times, cycle = 0, interp = LINEAR) {
  const values = sampleMany(c, times, cycle);
  c.times = Float32Array.from(times);
  c.values = values;
  c.interp = new Uint8Array(times.length).fill(interp);
  if (c.type === 'rot') makeQuatsContinuous(c.values);
  return c;
}

/** Flip quaternion signs so consecutive keys are in the same hemisphere. */
export function makeQuatsContinuous(values) {
  for (let i = 4; i < values.length; i += 4) {
    const d = values[i] * values[i - 4] + values[i + 1] * values[i - 3] + values[i + 2] * values[i - 2] + values[i + 3] * values[i - 1];
    if (d < 0) for (let k = 0; k < 4; k++) values[i + k] = -values[i + k];
  }
  return values;
}

/** True when every key of the channel has the same value (within tolerance). */
export function isConstant(c, tol = 1e-5) {
  const s = STRIDE[c.type];
  const n = c.times.length;
  for (let i = 1; i < n; i++) {
    if (s === 4) {
      const d = Math.abs(
        c.values[i * 4] * c.values[0] + c.values[i * 4 + 1] * c.values[1] + c.values[i * 4 + 2] * c.values[2] + c.values[i * 4 + 3] * c.values[3]
      );
      if (1 - d > tol) return false;
    } else {
      for (let k = 0; k < 3; k++) if (Math.abs(c.values[i * 3 + k] - c.values[k]) > tol) return false;
    }
  }
  return true;
}

/** Regular grid of times from t0 to t1 (inclusive) at `fps`. */
export function frameTimes(t0, t1, fps) {
  const out = [];
  const step = 1 / fps;
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  for (let k = 0; k <= n; k++) out.push(Math.min(t1, t0 + k * step));
  if (out.length > 1 && Math.abs(out[out.length - 1] - out[out.length - 2]) < KEY_EPS) out.pop();
  if (Math.abs(out[out.length - 1] - t1) > KEY_EPS) out.push(t1);
  return out;
}

/** Union of several sorted time lists, de-duplicated within eps. */
export function mergeTimes(...lists) {
  const all = [];
  for (const l of lists) for (const t of l) all.push(t);
  all.sort((a, b) => a - b);
  const out = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] > KEY_EPS) out.push(t);
  return out;
}
