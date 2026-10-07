import * as THREE from 'three';
import { assert, near, quatNear, tPoseCharacter, needs, ROOT, PACK } from './helpers.js';
import { loadGlb } from './glb-node.js';
import { analyzeRig, socketKind } from '../src/core/rig.js';
import { addSockets, missingSockets } from '../src/io/sockets.js';
import path from 'node:path';

export function socketNamesAreRecognised() {
  assert(socketKind('Weapon_R') === 'weapon.R');
  assert(socketKind('weapon_l') === 'weapon.L');
  assert(socketKind('mixamorig:Weapon_Back') === 'weaponback');
  assert(socketKind('Hand_R') === null && socketKind('WeaponMaster') === null);
}

export function builtSkeletonHasSockets() {
  const { mesh: sm, rig } = tPoseCharacter();
  assert(rig.humanoid, 'still humanoid');
  for (const [name, kind, parent] of [['Weapon_R', 'weapon.R', 'hand.R'], ['Weapon_L', 'weapon.L', 'hand.L'], ['Weapon_Back', 'weaponback', 'chest']]) {
    const i = rig.byName.get(name);
    assert(i !== undefined, `${name} exists`);
    assert(rig.kind[i] === kind && rig.group[i] === 'attach' && !rig.core.has(i), `${name} is an attachment point`);
    assert(rig.parent[i] === rig.byKind.get(parent), `${name} hangs from ${parent}`);
  }
  // Palm grip between wrist and finger tip; holster behind the chest.
  near(rig.restWorld.p[rig.byName.get('Weapon_R')].x, -0.76, 1e-4, 'grip x');
  assert(rig.restWorld.p[rig.byName.get('Weapon_Back')].z < -0.05, 'holster behind the back');
  assert(rig.mirror[rig.byName.get('Weapon_R')] === rig.byName.get('Weapon_L'), 'sockets mirror');
  // Sockets never deform the mesh.
  const sockets = new Set(['Weapon_R', 'Weapon_L', 'Weapon_Back'].map((n) => rig.byName.get(n)));
  const si = sm.geometry.attributes.skinIndex,
    sw = sm.geometry.attributes.skinWeight;
  for (let v = 0; v < si.count; v++) for (let k = 0; k < 4; k++) assert(!(sw.getComponent(v, k) > 0 && sockets.has(si.getComponent(v, k))), 'no weights on sockets');
}

export function socketsAddedToExistingRig() {
  needs(PACK);
  const g = loadGlb(path.join(ROOT, PACK));
  const rig0 = analyzeRig(g.scene, g.bones, g.box);
  // A skinned mesh bound to the skeleton, as in the app.
  const skel = new THREE.Skeleton(g.bones);
  const sm = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  g.scene.add(sm);
  g.scene.updateMatrixWorld(true);
  sm.bind(skel, sm.matrixWorld);
  assert(missingSockets(rig0).length === 3, 'none at first');
  const added = addSockets({ rig: rig0, root: g.scene });
  assert(added.length === 3, 'three sockets added');
  const rig = analyzeRig(g.scene, sm.skeleton.bones, g.box);
  // Existing labels keep their bone indices (clips and selections stay valid).
  for (const k of ['hips', 'hand.R', 'hand.L', 'foot.L', 'head', 'chest']) assert(rig.byKind.get(k) === rig0.byKind.get(k), `${k} unchanged`);
  const r = rig.byName.get('Weapon_R');
  assert(rig.kind[r] === 'weapon.R' && rig.parent[r] === rig.byKind.get('hand.R'), 'right socket under the right hand');
  // Socket rests in the character frame and sits within a hand's length of the wrist.
  quatNear(rig.restWorld.q[r], rig.baseQ, 0.01, 'socket orientation = model frame');
  assert(rig.restWorld.p[r].distanceTo(rig.restWorld.p[rig.byKind.get('hand.R')]) < 0.12 * rig.height, 'grip near the hand');
  // Bind matrices consistent: socket and parent have the same bind-relative transform at rest.
  const bi = sm.skeleton.bones.indexOf(rig.bones[r]);
  const pi = sm.skeleton.bones.indexOf(rig.bones[rig.parent[r]]);
  const a = rig.bones[r].matrixWorld.clone().multiply(sm.skeleton.boneInverses[bi]);
  const b = rig.bones[rig.parent[r]].matrixWorld.clone().multiply(sm.skeleton.boneInverses[pi]);
  a.elements.forEach((v, k) => near(v, b.elements[k], 1e-4, 'bind consistency'));
  assert(addSockets({ rig, root: g.scene }).length === 0, 'idempotent');
}
