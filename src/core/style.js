// Move styling: high-level, slider-friendly adjustments of a whole movement.
// applyStyle(base, rig, params) never touches `base`; it returns a new baked clip.
import * as THREE from 'three';
import { cloneClip, getTrack } from './clip.js';
import * as ops from './ops.js';
import { applyPose, evalWorld } from './evaluate.js';
import { frameTimes, setKey, makeChannel, makeQuatsContinuous } from './channel.js';
import { bonesInSet, makeScratchSkeleton } from './rig.js';
import { solveTwoBone, bendHintFor } from './ik.js';
import { keyBone } from './keying.js';

const DEG = Math.PI / 180;

export const STYLE_DEFAULTS = {
  speed: 1, // tempo (2 = twice as fast)
  intensity: 1, // whole-body energy
  arms: 1, // arm swing
  legs: 1, // stride
  bounce: 1, // hips up/down
  lean: 0, // degrees, + forward
  crouch: 0, // 0..1 of leg length (feet stay planted)
  armsOut: 0, // degrees, + away from the body
  headLevel: 0, // 0..1: keep the eyes on the horizon (cancel head pitch/roll, keep turns)
  headNod: 0, // degrees, + down
  headTurn: 0, // degrees, + to the character's left
  smooth: 0, // frames
  life: 0, // degrees of organic noise
  mirror: false,
  loop: null, // null = keep the source's setting
};

export function isDefaultStyle(p) {
  return Object.entries(STYLE_DEFAULTS).every(([k, v]) => k === 'loop' || p[k] === undefined || p[k] === v);
}

function axes(rig) {
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  fwd[rig.forwardAxis] = rig.forwardSign;
  const left = new THREE.Vector3().crossVectors(up, fwd).normalize();
  return { up, fwd, left };
}

/** Rotate a bone by `deg` about a world axis, expressed in its parent's rest frame, on every key. */
export function offsetRotation(clip, rig, i, worldAxis, deg) {
  if (i == null || i < 0 || !deg) return;
  const L = clip.layers[0];
  const name = rig.names[i];
  let ch = L.tracks[name]?.rot;
  if (!ch || !ch.times.length) {
    ch = getTrack(L, name, 'rot', true);
    setKey(ch, 0, rig.rest[i].q.toArray());
  }
  const p = rig.parent[i];
  const parentRest = p < 0 ? rig.baseQ : rig.restWorld.q[p];
  const axis = worldAxis.clone().applyQuaternion(parentRest.clone().invert()).normalize();
  const R = new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
  const q = new THREE.Quaternion();
  for (let k = 0; k < ch.times.length; k++) {
    q.fromArray(ch.values, k * 4).premultiply(R).normalize();
    q.toArray(ch.values, k * 4);
  }
}

/**
 * Keep the head level: real people keep their eyes on the horizon while the body leans and
 * bobs. Removes `amount` (0..1) of the head's world tilt (nod + side roll) relative to its rest
 * pose, keeping its left/right turn. Big-headed characters need this most.
 */
export function keepHeadLevel(clip, rig, amount, fps = 30) {
  const head = rig.special.head ?? rig.byKind.get('head');
  if (head == null || head < 0 || !(amount > 0)) return;
  const up = new THREE.Vector3(0, 1, 0);
  const restW = rig.restWorld.q[head];
  const restInv = restW.clone().invert();
  const p = rig.parent[head];
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const vals = [];
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  const D = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  for (const t of times) {
    evalWorld(clip, t, rig, ws);
    D.copy(ws.wq[head]).multiply(restInv); // world rotation away from rest
    // swing-twist about world up: the twist part is the head's turn, which we keep
    const ax = up.clone().multiplyScalar(up.dot(new THREE.Vector3(D.x, D.y, D.z)));
    twist.set(ax.x, ax.y, ax.z, D.w);
    if (twist.lengthSq() < 1e-12) twist.identity();
    else twist.normalize();
    const target = D.clone().slerp(twist, Math.min(1, amount)).multiply(restW);
    const parentW = p < 0 ? rig.baseQ : ws.wq[p];
    vals.push(parentW.clone().invert().multiply(target).normalize().toArray());
  }
  // Replace the whole track (old keys between frames would pull the head back down).
  getTrack(clip.layers[0], rig.names[head], 'rot', true);
  const ch = makeChannel('rot', times, Float32Array.from(vals.flat()));
  makeQuatsContinuous(ch.values);
  clip.layers[0].tracks[rig.names[head]].rot = ch;
}

/** Scale the hips' vertical motion around its average. */
function bounce(clip, rig, factor) {
  const hips = rig.special.hips;
  const ch = hips >= 0 ? clip.layers[0].tracks[rig.names[hips]]?.pos : null;
  if (!ch || ch.times.length < 2) return;
  let mean = 0;
  for (let k = 0; k < ch.times.length; k++) mean += ch.values[k * 3 + 1];
  mean /= ch.times.length;
  for (let k = 0; k < ch.times.length; k++) ch.values[k * 3 + 1] = mean + (ch.values[k * 3 + 1] - mean) * factor;
}

/** Lower the hips by `amount` × leg length every frame while leg IK keeps the feet where they were. */
export function crouch(clip, rig, amount, fps = 30) {
  const hips = rig.special.hips;
  const legs = ['L', 'R'].map((s) => rig.ik[`foot.${s}`]).filter(Boolean);
  if (hips == null || hips < 0 || !legs.length || amount <= 0) return;
  const legLen = rig.restWorld.p[hips].y - rig.ground;
  const drop = amount * legLen * 0.45;
  const orig = cloneClip(clip);
  const sk = makeScratchSkeleton(rig);
  const hint = bendHintFor(rig, 'forward');
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const pq = new THREE.Quaternion();
  for (const t of times) {
    applyPose(orig, t, rig, sk.bones);
    sk.root.updateMatrixWorld(true);
    const feet = legs.map((ik) => ({ ik, pos: sk.bones[ik.end].getWorldPosition(new THREE.Vector3()), quat: sk.bones[ik.end].getWorldQuaternion(new THREE.Quaternion()) }));
    const hb = sk.bones[hips];
    hb.parent.getWorldQuaternion(pq);
    hb.position.add(new THREE.Vector3(0, -drop, 0).applyQuaternion(pq.clone().invert()));
    sk.root.updateMatrixWorld(true);
    for (const f of feet) {
      const e = sk.bones[f.ik.end];
      solveTwoBone(sk.bones[f.ik.upper], sk.bones[f.ik.lower], e, f.pos, { bendHint: hint, keepEndRotation: false });
      e.parent.getWorldQuaternion(pq);
      e.quaternion.copy(pq.invert().multiply(f.quat));
      e.updateWorldMatrix(false, true);
    }
    const key = (i, which) => keyBone(clip, 0, rig.names[i], t, { p: sk.bones[i].position, q: sk.bones[i].quaternion, s: sk.bones[i].scale }, rig.rest[i], which);
    key(hips, { rot: false, pos: true, scl: false });
    for (const f of feet) for (const b of [f.ik.upper, f.ik.lower, f.ik.end]) key(b, { rot: true, pos: false, scl: false });
  }
}

/** Apply a style recipe to a base clip and return a new clip. */
export function applyStyle(base, rig, params = {}, { fps = 30 } = {}) {
  const p = { ...STYLE_DEFAULTS, ...params };
  const c = cloneClip(base, true);
  const ctx = { rig, li: 0, bones: null, range: null, fps };
  if (c.layers.length > 1) ops.bakeLayers(c, ctx, { fps });
  const set = (name) => new Set(bonesInSet(rig, name).map((i) => rig.names[i]));
  const changed = !isDefaultStyle(p);

  if (p.speed !== 1 && p.speed > 0) ops.scaleTime(c, 1 / p.speed);
  if (p.smooth > 0) ops.smooth(c, ctx, { radius: p.smooth, fps });
  if (p.intensity !== 1) ops.amplify(c, { ...ctx, bones: set('core') }, { factor: p.intensity, pivot: 'mean', position: true, fps });
  if (p.arms !== 1) ops.amplify(c, { ...ctx, bones: set('arms') }, { factor: p.arms, pivot: 'mean', position: false, fps });
  if (p.legs !== 1) ops.amplify(c, { ...ctx, bones: set('legs') }, { factor: p.legs, pivot: 'mean', position: false, fps });
  if (p.bounce !== 1) bounce(c, rig, p.bounce);

  const { up, fwd, left } = axes(rig);
  if (p.lean) {
    const chain = [...(rig.chains.spine || []), rig.special.chest].filter((i) => i != null && i >= 0);
    const bones = chain.length ? chain : [rig.special.hips];
    for (const i of bones) offsetRotation(c, rig, i, left, p.lean / bones.length);
  }
  if (p.armsOut) {
    offsetRotation(c, rig, rig.byKind.get('upperarm.L'), fwd, p.armsOut);
    offsetRotation(c, rig, rig.byKind.get('upperarm.R'), fwd, -p.armsOut);
  }
  const head = rig.special.head ?? rig.byKind.get('head');
  if (p.headLevel > 0) keepHeadLevel(c, rig, p.headLevel, fps);
  if (p.headNod) offsetRotation(c, rig, head, left, p.headNod);
  if (p.headTurn) offsetRotation(c, rig, head, up, p.headTurn);

  if (p.crouch > 0) crouch(c, rig, p.crouch, fps);
  if (p.life > 0) ops.addNoise(c, { ...ctx, bones: set('core') }, { amount: p.life, frequency: 1.2, seed: 3, fps });
  if (p.mirror) ops.mirrorClip(c, ctx);
  c.loop = p.loop ?? base.loop;
  if (c.loop && changed && c.duration > 0) ops.loopFix(c, ctx, { frames: 4, fps });
  return c;
}
