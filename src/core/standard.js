// The AnimStudio standard skeleton and tools to turn many reference styles into one move.
//
// Library moves are stored on this neutral humanoid (no external files needed), and are
// retargeted to any character on use.
import * as THREE from 'three';
import { analyzeRig } from './rig.js';
import { makeClip, makeLayer } from './clip.js';
import { evalBone, makeXform } from './evaluate.js';
import { frameTimes, makeChannel, makeQuatsContinuous } from './channel.js';
import { reduceChannel } from './ops.js';

export const STANDARD_RIG_ID = 'animstudio-standard-v1';

// Joint positions in metres for a 1.8 m neutral humanoid facing +Z (left = +X), arms down.
const JOINTS = {
  Root: [0, 0, 0],
  Hips: [0, 0.97, 0],
  Spine: [0, 1.12, 0.005],
  Chest: [0, 1.3, 0.01],
  Neck: [0, 1.5, 0],
  Head: [0, 1.6, 0.02],
  HeadTop_End: [0, 1.8, 0.02],
  Clavicle_L: [0.05, 1.46, 0.01],
  UpperArm_L: [0.19, 1.44, -0.01],
  ForeArm_L: [0.24, 1.15, -0.03],
  Hand_L: [0.27, 0.9, 0.0],
  HandTip_End_L: [0.28, 0.72, 0.01],
  Thigh_L: [0.1, 0.93, 0],
  Calf_L: [0.11, 0.5, 0.01],
  Foot_L: [0.115, 0.08, -0.02],
  Toe_L: [0.12, 0.02, 0.11],
  Toe_End_L: [0.12, 0.02, 0.17],
};
const PARENT = {
  Hips: 'Root', Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck', HeadTop_End: 'Head',
  Clavicle_L: 'Chest', UpperArm_L: 'Clavicle_L', ForeArm_L: 'UpperArm_L', Hand_L: 'ForeArm_L', HandTip_End_L: 'Hand_L',
  Thigh_L: 'Hips', Calf_L: 'Thigh_L', Foot_L: 'Calf_L', Toe_L: 'Foot_L', Toe_End_L: 'Toe_L',
};
for (const k of Object.keys(JOINTS)) {
  if (!k.endsWith('_L')) continue;
  const r = k.replace(/_L$/, '_R');
  const [x, y, z] = JOINTS[k];
  JOINTS[r] = [-x, y, z];
  PARENT[r] = PARENT[k].replace(/_L$/, '_R');
}

let cached = null;
/** The standard rig (built once). */
export function standardRig() {
  if (cached) return cached;
  const root = new THREE.Group();
  const bones = {};
  for (const name of Object.keys(JOINTS)) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
  }
  for (const [name, b] of Object.entries(bones)) {
    const p = PARENT[name];
    const pos = new THREE.Vector3(...JOINTS[name]);
    if (p) {
      bones[p].add(b);
      b.position.copy(pos.sub(new THREE.Vector3(...JOINTS[p])));
    } else {
      root.add(b);
      b.position.copy(pos);
    }
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.15), new THREE.Vector3(0.3, 1.8, 0.2));
  cached = analyzeRig(root, Object.values(bones), box);
  cached.standard = STANDARD_RIG_ID;
  return cached;
}

/** Local rotations of the core bones on a normalised-time grid (for phase alignment). */
function signature(clip, rig, N) {
  const x = makeXform();
  const core = [...rig.core];
  const out = [];
  for (let k = 0; k < N; k++) {
    const t = (k / N) * clip.duration;
    const row = [];
    for (const i of core) {
      evalBone(clip, rig.names[i], t, rig.rest[i], x);
      row.push(x.q.clone());
    }
    out.push(row);
  }
  return out;
}

/** Best cyclic shift (fraction of the cycle) that lines `clip` up with `ref`. */
export function phaseShift(ref, clip, rig, N = 36) {
  const a = signature(ref, rig, N);
  const b = signature(clip, rig, N);
  let best = 0,
    bestErr = Infinity;
  for (let s = 0; s < N; s++) {
    let err = 0;
    for (let k = 0; k < N; k++) {
      const ra = a[k],
        rb = b[(k + s) % N];
      for (let j = 0; j < ra.length; j++) err += 1 - Math.abs(ra[j].dot(rb[j]));
    }
    if (err < bestErr) [bestErr, best] = [err, s];
  }
  return best / N;
}

/**
 * Average several clips (all on `rig`) into one: time-normalised, cyclic phase aligned for
 * loops, quaternions averaged per bone. Returns a new single-layer clip.
 */
export function averageClips(clips, rig, { fps = 30, name = 'Move', loop = null, tolerance = 0.1 } = {}) {
  if (!clips.length) throw new Error('Nothing to average');
  const isLoop = loop ?? clips.filter((c) => c.loop).length * 2 >= clips.length;
  // Reference = the clip with the median duration.
  const sorted = [...clips].sort((a, b) => a.duration - b.duration);
  const ref = sorted[sorted.length >> 1];
  const shifts = clips.map((c) => (isLoop && c !== ref && c.duration > 0 ? phaseShift(ref, c, rig) : 0));
  const D = clips.reduce((s, c) => s + c.duration, 0) / clips.length;
  const out = makeClip(name, D);
  out.loop = isLoop;
  const times = D > 0 ? frameTimes(0, D, fps) : [0];
  const x = makeXform();
  const qs = new THREE.Quaternion();
  const ps = new THREE.Vector3();
  const L = out.layers[0];
  for (let i = 0; i < rig.bones.length; i++) {
    if (rig.group[i] === 'attach') continue;
    const name_ = rig.names[i];
    const anyTrack = clips.some((c) => c.layers.some((l) => l.tracks[name_]));
    if (!anyTrack) continue;
    const rot = new Float32Array(times.length * 4);
    const pos = new Float32Array(times.length * 3);
    let hasPos = clips.some((c) => c.layers.some((l) => l.tracks[name_]?.pos));
    times.forEach((t, k) => {
      const u = D > 0 ? t / D : 0;
      let sum = [0, 0, 0, 0];
      let ref0 = null;
      ps.set(0, 0, 0);
      clips.forEach((c, ci) => {
        let uu = u + shifts[ci];
        if (isLoop) uu -= Math.floor(uu);
        else uu = Math.min(1, uu);
        evalBone(c, name_, uu * c.duration, rig.rest[i], x);
        const q = x.q;
        if (!ref0) ref0 = q.clone();
        const sgn = ref0.dot(q) < 0 ? -1 : 1;
        sum = [sum[0] + q.x * sgn, sum[1] + q.y * sgn, sum[2] + q.z * sgn, sum[3] + q.w * sgn];
        ps.add(x.p);
      });
      qs.set(...sum).normalize().toArray(rot, k * 4);
      ps.divideScalar(clips.length).toArray(pos, k * 3);
    });
    const rc = makeChannel('rot', times, rot);
    makeQuatsContinuous(rc.values);
    if (tolerance > 0) reduceChannel(rc, (tolerance * Math.PI) / 180);
    L.tracks[name_] = { rot: rc };
    if (hasPos && (rig.kind[i] === 'hips' || rig.kind[i] === 'root')) {
      const pc = makeChannel('pos', times, pos);
      if (tolerance > 0) reduceChannel(pc, 0.0005);
      L.tracks[name_].pos = pc;
    }
  }
  out.meta = { source: 'standard', note: `average of ${clips.length} style(s)` };
  return out;
}

export { makeLayer };
