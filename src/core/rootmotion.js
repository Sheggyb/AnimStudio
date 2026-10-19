// Root motion for game engines: the character's travel goes on the root bone, which engines move
// the character controller by (Godot AnimationTree › Root Motion, Unity "Apply Root Motion",
// Unreal "Enable Root Motion"). The hips keep everything else (bounce, sway, the body's own
// motion), relative to the root.
import * as THREE from 'three';
import { frameTimes, makeChannel, makeQuatsContinuous } from './channel.js';
import { evalWorld } from './evaluate.js';

/** The root bone root motion goes on: a bone above the hips (skeletons AnimStudio builds have one). */
export function rootBone(rig) {
  const r = rig.special.root,
    h = rig.special.hips;
  if (r == null || r < 0 || h == null || h < 0 || r === h) return -1;
  for (let p = rig.parent[h]; p >= 0; p = rig.parent[p]) if (p === r) return r;
  return -1;
}

const yawOf = (q, up, fwd) => {
  const f = fwd.clone().applyQuaternion(q);
  f.addScaledVector(up, -f.dot(up));
  return f.lengthSq() < 1e-10 ? 0 : Math.atan2(f.x, f.z);
};

/**
 * Gaussian smoothing of a series of numbers (sigma in samples). Only the wobble around the
 * straight line from the first to the last value is smoothed, so the ends (and the distance
 * travelled) stay exact.
 */
function smoothSeries(v, sigma) {
  const n = v.length;
  if (sigma < 0.5 || n < 3) return v.slice();
  const line = (i) => v[0] + ((v[n - 1] - v[0]) * i) / (n - 1);
  const res = v.map((x, i) => x - line(i));
  const R = Math.ceil(sigma * 3);
  const w = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  return v.map((_, i) => {
    let s = 0,
      ws = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      // past the ends the wobble mirrors (it is zero at both ends); further out (short moves) it's zero
      const m = j < 0 ? -j : j > n - 1 ? 2 * (n - 1) - j : j;
      const r = m < 0 || m > n - 1 ? 0 : m === j ? res[m] : -res[m];
      s += r * w[k + R];
      ws += w[k + R];
    }
    return line(i) + s / ws;
  });
}

/**
 * Move the hips' horizontal travel onto the root bone, on the base layer (layers above keep
 * adding to the hips). follow: 'line' (steady speed from the first frame to the last: cycles),
 * 'smooth' (the travel without the hips' sway: one-shot moves) or 'exact'. With `turn`, the
 * root also turns with the body (moves that change direction). Returns a message.
 */
export function extractRootMotion(clip, ctx, { follow = null, turn = false, smooth = 0.3, fps = 30 } = {}) {
  const rig = ctx.rig;
  const r = rootBone(rig);
  const h = rig.special.hips;
  if (r < 0) return 'This skeleton has no root bone above the hips (Mixamo rigs): use In place, or rig the character with Build skeleton';
  follow ||= clip.loop ? 'line' : 'smooth';
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const n = times.length;
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  fwd[rig.forwardAxis] = rig.forwardSign;
  const base = { ...clip, layers: [clip.layers[0]] }; // the travel that is in the motion itself
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  const hipsW = [],
    hipsQ = [],
    rootQ = [];
  for (const t of times) {
    evalWorld(base, t, rig, ws);
    hipsW.push(ws.wp[h].clone());
    hipsQ.push(ws.wq[h].clone());
    rootQ.push(ws.wq[r].clone());
  }
  // The root's path on the ground: where the hips are, flattened, from where it rests.
  const restRoot = rig.restWorld.p[r];
  const restHips = rig.restWorld.p[h];
  let px = hipsW.map((p) => p.x - restHips.x + restRoot.x);
  let pz = hipsW.map((p) => p.z - restHips.z + restRoot.z);
  if (follow === 'line' && n > 1) {
    const [x0, x1, z0, z1] = [px[0], px[n - 1], pz[0], pz[n - 1]];
    px = px.map((_, k) => x0 + ((x1 - x0) * k) / (n - 1));
    pz = pz.map((_, k) => z0 + ((z1 - z0) * k) / (n - 1));
  } else if (follow === 'smooth') {
    px = smoothSeries(px, smooth * fps);
    pz = smoothSeries(pz, smooth * fps);
  }
  // Turning: the root turns with the hips' heading (smoothed), measured from the rest pose.
  const restYaw = yawOf(rig.restWorld.q[h], up, fwd);
  let yaw = hipsQ.map((q) => yawOf(q, up, fwd) - restYaw);
  for (let k = 1; k < n; k++) yaw[k] = yaw[k - 1] + Math.atan2(Math.sin(yaw[k] - yaw[k - 1]), Math.cos(yaw[k] - yaw[k - 1])); // unwrap
  yaw = turn ? smoothSeries(yaw, smooth * fps) : yaw.map(() => 0);

  const L = clip.layers[0];
  const rp = rig.parent[r];
  // Bones between the root and the hips keep their local transforms.
  const chain = rig.pathDown(r, h).slice(0, -1); // below the root, above the hips
  const rootPos = new Float32Array(n * 3),
    rootRot = new Float32Array(n * 4),
    hipsPos = new Float32Array(n * 3),
    hipsRot = new Float32Array(n * 4);
  const mW = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const pW = new THREE.Vector3(),
    qW = new THREE.Quaternion(),
    sW = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    evalWorld(base, times[k], rig, ws);
    // Root, in model space: on the ground path, at its rest height, turned by the yaw.
    const turnQ = new THREE.Quaternion().setFromAxisAngle(up, yaw[k]);
    const rq = turnQ.clone().multiply(rootQ[k]);
    const rpos = new THREE.Vector3(px[k], restRoot.y, pz[k]);
    // ...to its parent's space.
    const parQ = rp < 0 ? rig.baseQ : ws.wq[rp];
    const parP = rp < 0 ? rig.baseP : ws.wp[rp];
    const invParQ = parQ.clone().invert();
    rpos.clone().sub(parP).applyQuaternion(invParQ).toArray(rootPos, k * 3);
    invParQ.clone().multiply(rq).normalize().toArray(rootRot, k * 4);
    // Hips: the same place in the model as before, so its parent chain is walked from the new root.
    mW.compose(rpos, rq, new THREE.Vector3(1, 1, 1));
    for (const b of chain) {
      tmp.compose(ws.lp[b], ws.lq[b], new THREE.Vector3(1, 1, 1));
      mW.multiply(tmp);
    }
    mW.decompose(pW, qW, sW);
    const inv = qW.clone().invert();
    hipsW[k].clone().sub(pW).applyQuaternion(inv).toArray(hipsPos, k * 3);
    inv.multiply(hipsQ[k]).normalize().toArray(hipsRot, k * 4);
  }
  const put = (bone, type, values) => {
    const ch = makeChannel(type, times, values);
    if (type === 'rot') makeQuatsContinuous(ch.values);
    (L.tracks[rig.names[bone]] ||= {})[type] = ch;
  };
  put(r, 'pos', rootPos);
  put(h, 'pos', hipsPos);
  if (turn) {
    put(r, 'rot', rootRot);
    put(h, 'rot', hipsRot);
  }
  const dist = Math.hypot(px[n - 1] - px[0], pz[n - 1] - pz[0]);
  return dist > 0.01 * rig.height ? `Root motion on ${rig.names[r]}: travels ${dist.toFixed(2)} m` : `Root motion on ${rig.names[r]} (this move stays in place)`;
}
