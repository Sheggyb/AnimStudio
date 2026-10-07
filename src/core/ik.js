// Inverse kinematics on live THREE.Bone objects.
//  - solveTwoBone: analytic limb IK (arm/leg) that keeps the current bend plane.
//  - solveCCD: iterative IK for arbitrary chains (tails, spines, hair).
import * as THREE from 'three';

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function worldPos(o, out) {
  return out.setFromMatrixPosition(o.matrixWorld);
}
function worldQuat(o, out) {
  o.matrixWorld.decompose(_p, out, _s);
  return out;
}

/**
 * Rotate `upper` and `lower` so that `end` reaches `target` (world space).
 * Closed-form two-joint IK (after Daniel Holden): bend with the law of cosines, which keeps
 * the a->c direction, then swing the whole chain onto the target. The bend plane is preserved, so the
 * elbow/knee keeps pointing where the animator had it.
 * @param {THREE.Vector3} bendHint world direction the middle joint should bend towards when the
 *   chain is fully straight (no bend plane to preserve).
 * @param {boolean} keepEndRotation keep the hand/foot world orientation unchanged.
 */
export function solveTwoBone(upper, lower, end, target, { bendHint = null, keepEndRotation = true } = {}) {
  upper.updateWorldMatrix(true, true);
  const a = worldPos(upper, new THREE.Vector3());
  const b = worldPos(lower, new THREE.Vector3());
  const c = worldPos(end, new THREE.Vector3());
  const endWQ = worldQuat(end, new THREE.Quaternion());
  const aGQ = worldQuat(upper, new THREE.Quaternion());
  const bGQ = worldQuat(lower, new THREE.Quaternion());

  const lab = a.distanceTo(b);
  const lcb = b.distanceTo(c);
  if (lab < 1e-6 || lcb < 1e-6) return false;
  const lat = clamp(a.distanceTo(target), 1e-4, lab + lcb - 1e-4);

  const ac = c.clone().sub(a).normalize();
  const ab = b.clone().sub(a).normalize();
  const ba = a.clone().sub(b).normalize();
  const bc = c.clone().sub(b).normalize();
  const at = target.clone().sub(a);
  if (at.lengthSq() < 1e-12) return false;
  at.normalize();

  const acab0 = Math.acos(clamp(ac.dot(ab), -1, 1));
  const babc0 = Math.acos(clamp(ba.dot(bc), -1, 1));
  const acat0 = Math.acos(clamp(ac.dot(at), -1, 1));
  const acab1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const babc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));

  const axis0 = new THREE.Vector3().crossVectors(ac, ab);
  if (axis0.lengthSq() < 1e-8) {
    // Straight limb: bend towards the hint (e.g. knees forward, elbows back).
    const hint = bendHint ? bendHint.clone() : new THREE.Vector3(0, 0, 1);
    axis0.crossVectors(ac, hint);
    if (axis0.lengthSq() < 1e-8) axis0.crossVectors(ac, new THREE.Vector3(1, 0, 0));
  }
  axis0.normalize();
  let axis1 = new THREE.Vector3().crossVectors(ac, at);
  if (axis1.lengthSq() < 1e-10) axis1.copy(axis0);
  else axis1.normalize();

  const aInv = aGQ.clone().invert();
  const bInv = bGQ.clone().invert();
  const r0 = new THREE.Quaternion().setFromAxisAngle(axis0.clone().applyQuaternion(aInv), acab1 - acab0);
  const r1 = new THREE.Quaternion().setFromAxisAngle(axis0.clone().applyQuaternion(bInv), babc1 - babc0);
  const r2 = new THREE.Quaternion().setFromAxisAngle(axis1.clone().applyQuaternion(aInv), acat0);

  // World: bend about axis0 first, then swing onto the target (A' = R2 * R0 * A  =>  local a * r2 * r0).
  upper.quaternion.multiply(r2.multiply(r0)).normalize();
  lower.quaternion.multiply(r1).normalize();
  upper.updateWorldMatrix(false, true);

  if (keepEndRotation && end.parent) {
    const pq = worldQuat(end.parent, new THREE.Quaternion());
    end.quaternion.copy(pq.invert().multiply(endWQ)).normalize();
    end.updateWorldMatrix(false, true);
  }
  return true;
}

/**
 * Pole vector: swing the limb around its root->end axis so the middle joint (elbow/knee) points
 * towards `pole` (a world direction). The end stays where it is. Use after solveTwoBone, which
 * otherwise keeps whatever bend plane the limb already had.
 */
export function applyPole(upper, lower, end, pole) {
  upper.updateWorldMatrix(true, true);
  const a = worldPos(upper, new THREE.Vector3());
  const b = worldPos(lower, new THREE.Vector3());
  const c = worldPos(end, new THREE.Vector3());
  const axis = c.clone().sub(a);
  if (axis.lengthSq() < 1e-12) return false;
  axis.normalize();
  const cur = b.clone().sub(a);
  cur.addScaledVector(axis, -cur.dot(axis));
  const want = pole.clone().addScaledVector(axis, -pole.dot(axis));
  if (cur.lengthSq() < 1e-12 || want.lengthSq() < 1e-12) return false;
  cur.normalize();
  want.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(cur, want); // rotation about `axis`
  const pq = upper.parent ? worldQuat(upper.parent, new THREE.Quaternion()) : new THREE.Quaternion();
  upper.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq)).normalize();
  upper.updateWorldMatrix(false, true);
  return true;
}

/**
 * Cyclic coordinate descent. `chain` lists the bones to rotate from root to tip; `effector`
 * is the object whose world position should reach `target`.
 */
export function solveCCD(chain, effector, target, { iterations = 16, tolerance = 1e-4, maxStep = 0.5 } = {}) {
  const jp = new THREE.Vector3();
  const ep = new THREE.Vector3();
  const toE = new THREE.Vector3();
  const toT = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  for (let it = 0; it < iterations; it++) {
    for (let k = chain.length - 1; k >= 0; k--) {
      const j = chain[k];
      j.updateWorldMatrix(true, true);
      worldPos(j, jp);
      worldPos(effector, ep);
      toE.subVectors(ep, jp);
      toT.subVectors(target, jp);
      if (toE.lengthSq() < 1e-12 || toT.lengthSq() < 1e-12) continue;
      toE.normalize();
      toT.normalize();
      q.setFromUnitVectors(toE, toT);
      const angle = 2 * Math.acos(clamp(q.w, -1, 1));
      if (angle > maxStep) q.slerp(new THREE.Quaternion(), 1 - maxStep / angle);
      // world-space rotation -> local: L' = P^-1 * q * P * L
      if (j.parent) worldQuat(j.parent, pq);
      else pq.identity();
      const local = pq.clone().invert().multiply(q).multiply(pq);
      j.quaternion.premultiply(local).normalize();
    }
    effector.updateWorldMatrix(true, false);
    if (worldPos(effector, ep).distanceTo(target) < tolerance) return true;
  }
  return false;
}

/** World-space direction a limb should bend towards when straight. */
export function bendHintFor(rig, kind) {
  const v = new THREE.Vector3();
  v[rig.forwardAxis] = rig.forwardSign * (kind === 'forward' ? 1 : -1);
  return v;
}
