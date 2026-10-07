// Anatomical pose controls that mean the same thing on any humanoid skeleton:
//   swing  (+) the bone's tip moves FORWARD (or UP for bones that already point forward,
//              e.g. feet/toes). Knee bend = negative calf swing; elbow bend = positive forearm swing.
//   spread (+) the tip moves AWAY from the body's midline (for centre bones: towards the
//              character's left).
//   twist  (+) rotation around the bone's own length (right-hand rule along the bone).
// All angles in degrees, relative to the rest pose and expressed in the parent's frame, so a
// value means the same regardless of how each rig orients its bone axes.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export function bodyAxes(rig) {
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  fwd[rig.forwardAxis] = rig.forwardSign;
  const left = new THREE.Vector3().crossVectors(up, fwd).normalize();
  return { up, fwd, left };
}

/** Rest direction of a bone (towards its main child), model space. */
export function restDir(rig, i) {
  const kids = rig.children[i].filter((c) => rig.group[c] !== 'attach');
  let best = -1,
    bl = 0;
  for (const c of kids) {
    const l = rig.subtree(c).length;
    if (l > bl) [bl, best] = [l, c];
  }
  if (best >= 0) {
    const d = rig.restWorld.p[best].clone().sub(rig.restWorld.p[i]);
    if (d.lengthSq() > 1e-10) return d.normalize();
  }
  // leaf: continue the parent's direction
  const p = rig.parent[i];
  if (p >= 0) {
    const d = rig.restWorld.p[i].clone().sub(rig.restWorld.p[p]);
    if (d.lengthSq() > 1e-10) return d.normalize();
  }
  return new THREE.Vector3(0, 1, 0);
}

function outward(rig, i, left) {
  const side = rig.restWorld.p[i].clone().sub(new THREE.Vector3(rig.center, 0, 0));
  const s = side.dot(left);
  return Math.abs(s) < rig.height * 0.02 ? left.clone() : left.clone().multiplyScalar(Math.sign(s));
}

/**
 * World-space rotation for anatomical values on bone i.
 * @param {{swing?:number, spread?:number, twist?:number}} v degrees
 */
export function anatomicalWorldRot(rig, i, v) {
  const { up, fwd, left } = bodyAxes(rig);
  const d = restDir(rig, i);
  let swingAxis = new THREE.Vector3().crossVectors(d, fwd);
  if (swingAxis.lengthSq() < 0.05) swingAxis = new THREE.Vector3().crossVectors(d, up); // bone points forward: swing = tip up
  swingAxis.normalize();
  let spreadAxis = new THREE.Vector3().crossVectors(d, outward(rig, i, left));
  if (spreadAxis.lengthSq() < 0.05) spreadAxis = fwd.clone().multiplyScalar(Math.sign(outward(rig, i, left).dot(left)) || 1); // bone points straight out: + = tip up, same as cross(d, outward) just below horizontal
  spreadAxis.normalize();
  const q = new THREE.Quaternion();
  if (v.twist) q.premultiply(new THREE.Quaternion().setFromAxisAngle(d, v.twist * DEG));
  if (v.swing) q.premultiply(new THREE.Quaternion().setFromAxisAngle(swingAxis, v.swing * DEG));
  if (v.spread) q.premultiply(new THREE.Quaternion().setFromAxisAngle(spreadAxis, v.spread * DEG));
  return q;
}

/** Local rotation for bone i: rest rotation with the anatomical offset applied in the parent frame. */
export function anatomicalLocal(rig, i, v, base = null) {
  const Rw = anatomicalWorldRot(rig, i, v);
  const p = rig.parent[i];
  const P = p < 0 ? rig.baseQ : rig.restWorld.q[p];
  const local = P.clone().invert().multiply(Rw).multiply(P); // world rotation -> parent frame
  return local.multiply(base ? base.clone() : rig.rest[i].q.clone());
}

/** Hips/root offset in metres along (left, up, forward) -> local position. */
export function bodyOffsetLocal(rig, i, [l = 0, u = 0, f = 0] = [], base = null) {
  const { up, fwd, left } = bodyAxes(rig);
  const w = left.clone().multiplyScalar(l).addScaledVector(up, u).addScaledVector(fwd, f);
  const p = rig.parent[i];
  const P = p < 0 ? rig.baseQ : rig.restWorld.q[p];
  return (base ? base.clone() : rig.rest[i].p.clone()).add(w.applyQuaternion(P.clone().invert()));
}

/** Resolve a bone reference: semantic label ("thigh.L", "head"), pretty label ("L Thigh") or raw name. */
export function resolveBone(rig, ref) {
  if (ref == null) return -1;
  const s = String(ref).trim();
  if (rig.byKind.has(s)) return rig.byKind.get(s);
  if (rig.byName.has(s)) return rig.byName.get(s);
  const low = s.toLowerCase();
  let i = rig.labels.findIndex((l) => l && l.toLowerCase() === low);
  if (i >= 0) return i;
  // tolerant forms: "left thigh", "thigh_l", "right upper arm"
  const side = /\b(left|l)\b|_l$|\.l$/i.test(s) ? 'L' : /\b(right|r)\b|_r$|\.r$/i.test(s) ? 'R' : null;
  const base = low.replace(/\b(left|right)\b|[_.](l|r)$/g, '').replace(/[^a-z]/g, '');
  const alias = { upperarm: 'upperarm', arm: 'upperarm', shoulder: 'clavicle', forearm: 'forearm', elbow: 'forearm', hand: 'hand', wrist: 'hand', thigh: 'thigh', upperleg: 'thigh', hip: 'thigh', leg: 'thigh', calf: 'calf', knee: 'calf', shin: 'calf', lowerleg: 'calf', foot: 'foot', ankle: 'foot', toe: 'toe', toes: 'toe', clavicle: 'clavicle', head: 'head', neck: 'neck.0', chest: 'chest', spine: 'spine.0', pelvis: 'pelvis', hips: 'hips', root: 'root' }[base];
  if (alias) {
    const k = ['head', 'chest', 'hips', 'pelvis', 'root', 'neck.0', 'spine.0'].includes(alias) ? alias : side ? `${alias}.${side}` : null;
    if (k && rig.byKind.has(k)) return rig.byKind.get(k);
  }
  return -1;
}

/** Bones an AI (or user) can drive, with their meaning. */
export function controllableBones(rig) {
  const out = [];
  for (const [k, i] of rig.byKind) {
    if (/^(finger|extra|armx|rootx)/.test(k)) continue;
    out.push({ id: k, label: rig.labels[i], bone: rig.names[i] });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
