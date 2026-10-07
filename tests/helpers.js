import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGlb } from './glb-node.js';
import { analyzeRig } from '../src/core/rig.js';
import { clipFromThree } from '../src/core/clip.js';
import * as THREE from 'three';
import { buildSkeleton } from '../src/io/rigbuild.js';

/** The AnimStudio folder; test models are given relative to it. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Test rigs. Animation files are not in the repository (people download their own), so tests
// that load them are skipped when they are missing. For the full suite, put the Quaternius
// Universal Animation Library packs (CC0) in animations/ as "Quaternius Pack 1.glb" and
// "Quaternius Pack 2.glb". The Mixamo pack (centimetres) and a character with a skeleton built
// by AnimStudio are used as extra rigs when present.
export const PACK = 'animations/Quaternius Pack 1.glb';
export const PACK2 = 'animations/Quaternius Pack 2.glb';
export const MIXAMO = 'animations/Mixamo Pack.glb';
export const exists = (name) => fs.existsSync(path.join(ROOT, name));
/** A character whose skeleton AnimStudio built (models/*_rigged.glb), if there is one. */
const builtRig = () => {
  const dir = path.join(ROOT, 'models');
  const f = fs.existsSync(dir) && fs.readdirSync(dir).find((n) => /_rigged\.glb$/i.test(n));
  return f ? [`models/${f}`] : [];
};
/** Every rig available for cross-rig tests (the files that are there). */
export const rigFiles = () => [...[PACK, PACK2, MIXAMO].filter(exists), ...builtRig()];

/** Thrown to skip a test whose input files are not there (the runner reports it as skipped). */
export class Skip extends Error {}
export function needs(name) {
  if (!exists(name)) throw new Skip(`needs ${name}`);
}

const cache = new Map();
/** Load a model (path relative to AnimStudio) and convert its clips. */
export function model(name = PACK) {
  if (cache.has(name)) return cache.get(name);
  needs(name);
  const g = loadGlb(path.join(ROOT, name));
  const rig = analyzeRig(g.scene, g.bones, g.box);
  const names = new Set(rig.names);
  const used = new Set();
  const clips = g.clips.map((tc) => {
    const c = clipFromThree(tc, names);
    let n = c.name,
      k = 2;
    while (used.has(n)) n = `${c.name}_${k++}`;
    used.add(n);
    c.name = n;
    c.meta.originalName = n;
    return c;
  });
  const m = { ...g, rig, clips, clip: (n) => clips.find((c) => c.name === n) };
  cache.set(name, m);
  return m;
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
export function near(a, b, eps = 1e-4, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg} expected ${b}, got ${a} (eps ${eps})`);
}
// Angle between rotations via the relative quaternion (precise for small angles, unlike acos(dot)).
export function quatAngleDeg(a, b) {
  const rx = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y;
  const ry = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x;
  const rz = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  const rw = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  return (2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw)) * 180) / Math.PI;
}
export function quatNear(a, b, epsDeg = 0.05, msg = '') {
  const ang = quatAngleDeg(a, b);
  if (ang > epsDeg) throw new Error(`${msg} quaternions differ by ${ang.toFixed(4)}°`);
}

/** Simple T-pose markers (Y up, facing +Z, left = +X), as the skeleton builder places them. */
export function tPoseMarkers() {
  const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
  const m = { pelvis: V(0, 0.9), chest: V(0, 1.25), neck: V(0, 1.45), headTop: V(0, 1.75) };
  for (const [s, x] of [['L', 1], ['R', -1]]) {
    Object.assign(m, {
      [`shoulder.${s}`]: V(0.18 * x, 1.42), [`elbow.${s}`]: V(0.45 * x, 1.42, -0.02), [`wrist.${s}`]: V(0.7 * x, 1.42), [`handTip.${s}`]: V(0.85 * x, 1.42),
      [`hip.${s}`]: V(0.1 * x, 0.88), [`knee.${s}`]: V(0.1 * x, 0.48), [`ankle.${s}`]: V(0.1 * x, 0.08), [`toe.${s}`]: V(0.1 * x, 0.02, 0.12),
    });
  }
  return m;
}

/** A T-posed box character rigged by AnimStudio's skeleton builder: { scene, mesh, rig }. */
export function tPoseCharacter() {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.3, 4, 12, 3).translate(0, 0.9, 0)));
  buildSkeleton({ scene, animations: [] }, tPoseMarkers(), { facing: 1 });
  const mesh = scene.children.find((o) => o.isSkinnedMesh);
  const rig = analyzeRig(scene, mesh.skeleton.bones, new THREE.Box3().setFromObject(scene));
  return { scene, mesh, rig };
}
