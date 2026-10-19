// Skeleton builder: auto-fit on a figure with known joints, and skeletons with fingers (no downloads needed).
import * as THREE from 'three';
import { assert, tPoseMarkers, mixamoRig } from './helpers.js';
import { autoFind, buildSkeleton, markerKeys, fingerBones, FINGERS } from '../src/io/rigbuild.js';
import { analyzeRig } from '../src/core/rig.js';
import { buildBoneMap } from '../src/core/retarget.js';

/** A T-posed figure made of boxes (Y up, facing +Z, left = +X), 1.8 m tall. */
function figure({ bandana = false } = {}) {
  const scene = new THREE.Group();
  const box = (w, h, d, x, y, z = 0) => {
    const seg = (l) => Math.max(1, Math.ceil(l / 0.015)); // dense like a real mesh
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, seg(w), seg(h), seg(d)), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    scene.add(m);
  };
  box(0.36, 0.6, 0.22, 0, 1.2); // torso 0.9 .. 1.5
  box(0.1, 0.1, 0.1, 0, 1.53); // neck
  box(0.22, 0.24, 0.22, 0, 1.68); // head 1.56 .. 1.8
  for (const s of [1, -1]) {
    box(0.42, 0.09, 0.09, s * 0.39, 1.44); // upper arm + forearm, 0.18 .. 0.6
    box(0.07, 0.06, 0.07, s * 0.62, 1.44); // wrist
    box(0.18, 0.04, 0.1, s * 0.74, 1.44); // hand, palm down: 0.65 .. 0.83
    box(0.13, 0.9, 0.13, s * 0.1, 0.48); // leg 0.03 .. 0.93
    box(0.12, 0.06, 0.26, s * 0.1, 0.03, 0.08); // foot, toes forward
  }
  if (bandana) box(0.85, 0.05, 0.03, 0.5, 1.72, -0.1); // a long tail off the back of the head, out to the left past the hand
  scene.updateMatrixWorld(true);
  return scene;
}

const near = (p, want, tol, what) => assert(p.distanceTo(want) < tol, `${what}: at (${p.toArray().map((x) => x.toFixed(2))}), want (${want.toArray().map((x) => x.toFixed(2))}) ±${tol}`);

export function autoFitFindsTheJoints() {
  for (const bandana of [false, true]) {
    const { markers: m, facing } = autoFind(figure({ bandana }));
    const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
    const what = bandana ? 'with a bandana: ' : '';
    assert(facing === 1, 'faces +Z');
    near(m.headTop, V(0, 1.79), 0.04, what + 'head top');
    assert(m.neck.y > 1.44 && m.neck.y < 1.6, `${what}neck at ${m.neck.y.toFixed(2)} m`);
    assert(m.pelvis.y > 0.8 && m.pelvis.y < 1.05, `${what}hips at ${m.pelvis.y.toFixed(2)} m`);
    for (const [s, x] of [['L', 1], ['R', -1]]) {
      near(m[`handTip.${s}`], V(x * 0.83, 1.44), 0.04, `${what}${s} hand tip`);
      near(m[`wrist.${s}`], V(x * 0.63, 1.44), 0.06, `${what}${s} wrist`);
      assert(Math.abs(m[`shoulder.${s}`].x) > 0.1 && Math.abs(m[`shoulder.${s}`].x) < 0.26 && Math.abs(m[`shoulder.${s}`].y - 1.44) < 0.07, `${what}${s} shoulder at (${m[`shoulder.${s}`].x.toFixed(2)}, ${m[`shoulder.${s}`].y.toFixed(2)})`);
      const e = m[`elbow.${s}`];
      assert(Math.abs(e.y - 1.44) < 0.05 && Math.abs(e.x) > 0.3 && Math.abs(e.x) < 0.5, `${what}${s} elbow on the arm at (${e.x.toFixed(2)}, ${e.y.toFixed(2)})`);
      near(m[`hip.${s}`], V(x * 0.1, m[`hip.${s}`].y), 0.04, `${what}${s} hip`);
      assert(m[`knee.${s}`].y > 0.35 && m[`knee.${s}`].y < 0.6, `${what}${s} knee at ${m[`knee.${s}`].y.toFixed(2)} m`);
      assert(m[`ankle.${s}`].y < 0.15 && m[`toe.${s}`].z > m[`ankle.${s}`].z, `${what}${s} ankle low, toes forward`);
      assert(Math.abs(m[`elbow.${s}`].z) < 0.06 && Math.abs(m[`knee.${s}`].z) < 0.07, `${what}${s} joints inside the body front to back`);
    }
  }
}

/** Finger markers spread over the hand of the helpers' T-pose markers. */
function withFingers(m) {
  const out = { ...m };
  for (const [s, x] of [['L', 1], ['R', -1]]) {
    const wrist = m[`wrist.${s}`];
    FINGERS.forEach((f, k) => {
      const z = f === 'thumb' ? 0.05 : 0.03 - (k - 1) * 0.02;
      out[`${f}.${s}`] = wrist.clone().add(new THREE.Vector3(x * (f === 'thumb' ? 0.03 : 0.07), 0, z));
      out[`${f}Tip.${s}`] = wrist.clone().add(new THREE.Vector3(x * (f === 'thumb' ? 0.09 : 0.15), 0, z));
    });
  }
  return out;
}

export function skeletonWithFingers() {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.8, 0.3, 12, 12, 3).translate(0, 0.9, 0)));
  const markers = withFingers(tPoseMarkers());
  assert(markerKeys(true).every((k) => markers[k]), 'every marker given');
  const r = buildSkeleton({ scene, animations: [] }, markers, { facing: 1 });
  assert(r.bones === 30 + 2 * 5 * 4, `${r.bones} bones (30 + 4 per finger)`);
  const mesh = scene.children.find((o) => o.isSkinnedMesh);
  const rig = analyzeRig(scene, mesh.skeleton.bones, new THREE.Box3().setFromObject(scene));
  assert(rig.humanoid, 'humanoid');
  for (const s of ['L', 'R'])
    FINGERS.forEach((f, fi) => {
      const [b1, b2, b3] = fingerBones(f, s);
      for (const [j, b] of [b1, b2, b3].entries()) assert(rig.kind[rig.byName.get(b)] === `finger.${s}.${fi}.${j}`, `${b} is labelled ${rig.kind[rig.byName.get(b)]}`);
      assert(rig.names[rig.parent[rig.byName.get(b1)]] === `Hand_${s}`, `${b1} hangs off the hand`);
    });
  // Some vertices of the hand area follow the finger bones.
  const sw = mesh.geometry.attributes.skinWeight,
    si = mesh.geometry.attributes.skinIndex;
  const fingerIdx = new Set(mesh.skeleton.bones.map((b, i) => (/^(Thumb|Index|Middle|Ring|Pinky)\d_/.test(b.name) ? i : -1)).filter((i) => i >= 0));
  let onFingers = 0;
  for (let v = 0; v < si.count; v++) for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > 0.5 && fingerIdx.has(si.getComponent(v, k))) onFingers++;
  assert(onFingers > 0, `${onFingers} vertices follow finger bones`);
  // Mixamo finger animation finds its way onto these fingers.
  const map = buildBoneMap(mixamoRig(), rig);
  const idx1 = rig.byName.get('Index1_L');
  assert(map.has(idx1), 'retargeting maps Mixamo index finger to Index1_L');
}
