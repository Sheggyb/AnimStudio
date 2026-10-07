// Pose evaluation: turns a clip's layer stack into local bone transforms.
//
// Layer modes:
//   base     – replaces the rest pose (first layer)
//   additive – rotation: q = q * slerp(I, key, weight)   (local, post-multiplied)
//              position: p += key * weight;  scale: s *= lerp(1, key, weight)
//   override – blends toward the key value by weight
import * as THREE from 'three';
import { sample } from './channel.js';

const b4 = new Float32Array(4);
const b3 = new Float32Array(3);
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();

export function makeXform() {
  return { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1) };
}

const maskSets = new WeakMap();
function inMask(layer, bone) {
  if (!layer.mask) return true;
  let set = maskSets.get(layer.mask);
  if (!set) maskSets.set(layer.mask, (set = new Set(layer.mask)));
  return set.has(bone);
}

/** Apply one layer's channels for a bone onto `out`. */
export function applyLayer(layer, tr, t, cycle, out) {
  const mode = layer.mode;
  const w = mode === 'base' ? 1 : layer.weight;
  if (tr.rot && tr.rot.times.length) {
    _q.fromArray(sample(tr.rot, t, b4, cycle));
    if (mode === 'base') out.q.copy(_q);
    else if (mode === 'additive') {
      if (w !== 1) _q.copy(_qi.identity().slerp(_q, w));
      out.q.multiply(_q);
    } else out.q.slerp(_q, w);
  }
  if (tr.pos && tr.pos.times.length) {
    _v.fromArray(sample(tr.pos, t, b3, cycle));
    if (mode === 'base') out.p.copy(_v);
    else if (mode === 'additive') out.p.addScaledVector(_v, w);
    else out.p.lerp(_v, w);
  }
  if (tr.scl && tr.scl.times.length) {
    _v.fromArray(sample(tr.scl, t, b3, cycle));
    if (mode === 'base') out.s.copy(_v);
    else if (mode === 'additive') out.s.set(out.s.x * (1 + (_v.x - 1) * w), out.s.y * (1 + (_v.y - 1) * w), out.s.z * (1 + (_v.z - 1) * w));
    else out.s.lerp(_v, w);
  }
}

/**
 * Local transform of one bone at time t.
 * opts.from / opts.upto restrict the layer range [from, upto); opts.solo evaluates one layer on top of base.
 */
export function evalBone(clip, bone, t, rest, out, opts = {}) {
  out.p.copy(rest.p);
  out.q.copy(rest.q);
  out.s.copy(rest.s);
  const layers = clip.layers;
  const cycle = clip.loop ? clip.duration : 0;
  const upto = opts.upto ?? layers.length;
  for (let li = opts.from ?? 0; li < upto; li++) {
    const L = layers[li];
    if (li > 0 && L.mute && !opts.ignoreMute) continue;
    if (opts.solo && li > 0 && L.id !== opts.solo) continue;
    const tr = L.tracks[bone];
    if (!tr || !inMask(L, bone)) continue;
    applyLayer(L, tr, t, cycle, out);
  }
  return out;
}

const _x = makeXform();

/**
 * Pose a set of bones (same order as rig.bones) for a clip at time t.
 * `bones` may be a ghost/scratch copy of the skeleton.
 */
export function applyPose(clip, t, rig, bones = rig.bones, opts) {
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (!clip) {
      const r = rig.rest[i];
      b.position.copy(r.p);
      b.quaternion.copy(r.q);
      b.scale.copy(r.s);
      continue;
    }
    evalBone(clip, rig.names[i], t, rig.rest[i], _x, opts);
    b.position.copy(_x.p);
    b.quaternion.copy(_x.q);
    b.scale.copy(_x.s);
  }
}

export function applyRest(rig, bones = rig.bones) {
  for (let i = 0; i < bones.length; i++) {
    const r = rig.rest[i];
    bones[i].position.copy(r.p);
    bones[i].quaternion.copy(r.q);
    bones[i].scale.copy(r.s);
  }
}

/**
 * Evaluate local transforms for all bones into flat arrays, then compose model-space (world)
 * rotations/positions without touching any Object3D. Used for trails, retargeting, analysis.
 */
export function evalWorld(clip, t, rig, out = null) {
  const n = rig.bones.length;
  out ||= { lq: [], lp: [], wq: [], wp: [] };
  for (let i = 0; i < n; i++) {
    out.lq[i] ||= new THREE.Quaternion();
    out.lp[i] ||= new THREE.Vector3();
    out.wq[i] ||= new THREE.Quaternion();
    out.wp[i] ||= new THREE.Vector3();
  }
  for (const i of rig.order) {
    if (clip) {
      evalBone(clip, rig.names[i], t, rig.rest[i], _x);
      out.lq[i].copy(_x.q);
      out.lp[i].copy(_x.p);
    } else {
      out.lq[i].copy(rig.rest[i].q);
      out.lp[i].copy(rig.rest[i].p);
    }
    const p = rig.parent[i];
    if (p < 0) {
      out.wq[i].copy(rig.baseQ).multiply(out.lq[i]);
      out.wp[i].copy(out.lp[i]).applyQuaternion(rig.baseQ).add(rig.baseP);
    } else {
      out.wq[i].copy(out.wq[p]).multiply(out.lq[i]);
      out.wp[i].copy(out.lp[i]).applyQuaternion(out.wq[p]).add(out.wp[p]);
    }
  }
  return out;
}
