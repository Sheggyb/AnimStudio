// Weapon sockets: non-deforming bones in the palms and on the back. Game engines attach weapons
// to them (Godot BoneAttachment3D, Unity/Unreal sockets) and AnimStudio's prop preview uses them.
import * as THREE from 'three';
import { applyRest } from '../core/evaluate.js';

export const SOCKETS = [
  { name: 'Weapon_R', parent: 'hand.R', label: 'Right hand' },
  { name: 'Weapon_L', parent: 'hand.L', label: 'Left hand' },
  { name: 'Weapon_Back', parent: 'chest', label: 'Back (holster)' },
];

/** Sockets this rig could have but doesn't yet. */
export function missingSockets(rig) {
  return SOCKETS.filter((s) => !rig.byName.has(s.name) && rig.byKind.has(s.parent));
}

/**
 * Rest transform of a socket relative to its parent bone. The socket's rest orientation is the
 * character's own frame (X left, Y up, Z forward), whatever the parent bone's orientation is.
 */
function socketLocal(rig, pi, s) {
  const H = rig.height;
  const wq = rig.restWorld.q[pi];
  const wp = rig.restWorld.p[pi];
  const target = wp.clone();
  if (s.parent.startsWith('hand')) {
    // Grip point: 40% from the wrist towards the hand tip (or along the forearm direction).
    const tip = rig.children[pi].find((c) => rig.group[c] !== 'attach');
    if (tip !== undefined) target.lerp(rig.restWorld.p[tip], 0.4);
    else {
      const fore = rig.parent[pi];
      const dir = fore >= 0 ? wp.clone().sub(rig.restWorld.p[fore]).normalize() : new THREE.Vector3(0, -1, 0);
      target.addScaledVector(dir, 0.04 * H);
    }
  } else {
    target[rig.forwardAxis] -= rig.forwardSign * 0.09 * H;
  }
  const inv = wq.clone().invert();
  return { p: target.sub(wp).applyQuaternion(inv), q: inv };
}

/**
 * Add the missing sockets to a loaded model in place (bones + every skinned mesh's skeleton).
 * Returns the names added. The caller must rebuild the model record (buildModel) afterwards.
 */
export function addSockets(model) {
  const rig = model.rig;
  const todo = missingSockets(rig);
  if (!todo.length) return [];
  applyRest(rig);
  model.root.updateMatrixWorld(true);
  const made = todo.map((s) => {
    const pi = rig.byKind.get(s.parent);
    const { p, q } = socketLocal(rig, pi, s);
    const b = new THREE.Bone();
    b.name = s.name;
    b.position.copy(p);
    b.quaternion.copy(q);
    rig.bones[pi].add(b);
    return { bone: b, parent: rig.bones[pi], local: new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)) };
  });
  model.root.updateMatrixWorld(true);
  // Extend each skeleton: inverse bind of a child = inverse(local) * inverse bind of its parent.
  const done = new Map();
  model.root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const sk = o.skeleton;
    if (!done.has(sk)) {
      const bones = sk.bones.slice();
      const inverses = sk.boneInverses.map((m) => m.clone());
      for (const m of made) {
        const pi = bones.indexOf(m.parent);
        if (pi < 0) continue;
        bones.push(m.bone);
        inverses.push(m.local.clone().invert().multiply(inverses[pi]));
      }
      done.set(sk, new THREE.Skeleton(bones, inverses));
    }
    o.bind(done.get(sk), o.bindMatrix);
  });
  return todo.map((s) => s.name);
}
