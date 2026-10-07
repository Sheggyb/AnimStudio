// Writing keys through the layer stack: given the pose the user sees, work out what value the
// active layer must store so the final evaluated pose matches it.
import * as THREE from 'three';
import { evalBone, makeXform } from './evaluate.js';
import { sample, setKey } from './channel.js';
import { getTrack } from './clip.js';

const below = makeXform();
const full = makeXform();
const aboveQ = new THREE.Quaternion();
const aboveP = new THREE.Vector3();
const aboveS = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const b4 = new Float32Array(4);
const b3 = new Float32Array(3);
const ID = new THREE.Quaternion();

function inMask(layer, bone) {
  return !layer.mask || layer.mask.includes(bone);
}

/** q^(1/w) style extrapolation from identity. */
function powFromIdentity(q, f, out) {
  return out.copy(ID).slerp(q, f);
}

// New channels get the requested interpolation; keys added to existing channels inherit from
// their neighbours (so dense captured data stays linear).
function put(layer, bone, type, t, v, interp) {
  const ch = getTrack(layer, bone, type, true);
  setKey(ch, t, v, ch.times.length ? null : interp);
}

/**
 * Key `bone` on layer `li` so the clip evaluates to `target` ({p,q,s} local) at time t.
 * which.rot/pos/scl: true = always, false = never, 'auto' = only if the track exists or the value changed.
 * Returns false if the layer can't hold a key (e.g. weight 0).
 */
export function keyBone(clip, li, bone, t, target, rest, which = { rot: true, pos: 'auto', scl: 'auto' }, interp = null) {
  const L = clip.layers[li];
  if (!L) return false;
  const w = L.mode === 'base' ? 1 : L.weight;
  if (Math.abs(w) < 1e-3) return false;
  const cycle = clip.loop ? clip.duration : 0;

  evalBone(clip, bone, t, rest, below, { upto: li });
  evalBone(clip, bone, t, rest, full);

  // Combined effect of additive layers stacked above the active one.
  aboveQ.identity();
  aboveP.set(0, 0, 0);
  aboveS.set(1, 1, 1);
  for (let k = li + 1; k < clip.layers.length; k++) {
    const U = clip.layers[k];
    if (U.mute || U.mode !== 'additive' || !inMask(U, bone)) continue;
    const tr = U.tracks[bone];
    if (!tr) continue;
    if (tr.rot?.times.length) aboveQ.multiply(powFromIdentity(_q.fromArray(sample(tr.rot, t, b4, cycle)), U.weight, _q2));
    if (tr.pos?.times.length) aboveP.addScaledVector(_v.fromArray(sample(tr.pos, t, b3, cycle)), U.weight);
    if (tr.scl?.times.length) {
      _v.fromArray(sample(tr.scl, t, b3, cycle));
      aboveS.set(aboveS.x * (1 + (_v.x - 1) * U.weight), aboveS.y * (1 + (_v.y - 1) * U.weight), aboveS.z * (1 + (_v.z - 1) * U.weight));
    }
  }

  const tr = L.tracks[bone];
  const want = (flag, exists, changed) => flag === true || (flag === 'auto' && (exists || changed));

  if (which.rot !== false) {
    const wantQ = _q.copy(target.q).multiply(_q2.copy(aboveQ).invert());
    let v;
    if (L.mode === 'base') v = wantQ.clone();
    else if (L.mode === 'additive') v = powFromIdentity(below.q.clone().invert().multiply(wantQ), 1 / w, new THREE.Quaternion());
    else v = below.q.clone().slerp(wantQ, 1 / w);
    put(L, bone, 'rot', t, v.normalize().toArray(), interp);
  }

  if (want(which.pos, !!tr?.pos, target.p.distanceTo(full.p) > 1e-6)) {
    const wantP = _v.copy(target.p).sub(aboveP);
    let v;
    if (L.mode === 'base') v = wantP.clone();
    else if (L.mode === 'additive') v = wantP.clone().sub(below.p).divideScalar(w);
    else v = below.p.clone().add(wantP.clone().sub(below.p).divideScalar(w));
    put(L, bone, 'pos', t, v.toArray(), interp);
  }

  if (want(which.scl, !!tr?.scl, target.s.distanceTo(full.s) > 1e-6)) {
    const wantS = _v.copy(target.s).divide(aboveS);
    let v;
    if (L.mode === 'base') v = wantS.clone();
    else if (L.mode === 'additive') v = new THREE.Vector3(1 + (wantS.x / below.s.x - 1) / w, 1 + (wantS.y / below.s.y - 1) / w, 1 + (wantS.z / below.s.z - 1) / w);
    else v = below.s.clone().add(wantS.clone().sub(below.s).divideScalar(w));
    put(L, bone, 'scl', t, v.toArray(), interp);
  }
  return true;
}

/** Read a bone's current local transform as a key target. */
export function boneTarget(bone) {
  return { p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() };
}
