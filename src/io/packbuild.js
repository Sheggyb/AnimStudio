// Build animation packs (one GLB = one skeleton + many clips) from files people downloaded
// themselves: Mixamo .fbx downloads, other .fbx/.glb animation files. Runs in the browser
// (start page › ＋ Add animations) and in Node (tools/build-mixamo-pack.mjs).
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { readFBX, readGLTF, SKIN_ANCHOR } from './loader.js';

const boneNames = (scene) => {
  const s = new Set();
  scene.traverse((o) => o.isBone && s.add(o.name));
  return s;
};

/** "Breathing Idle.fbx" -> "Breathing_Idle" (AnimStudio shows it as "Breathing idle"). */
export const moveName = (file) => file.replace(/\.(fbx|glb|gltf)$/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Move';

/** The take that actually moves (Mixamo files also carry an empty "Take 001"). */
const mainTake = (animations) => [...animations].sort((a, b) => b.tracks.length * b.duration - a.tracks.length * a.duration)[0];

async function readAny(name, buffer) {
  return /\.fbx$/i.test(name) ? readFBX(buffer) : readGLTF(buffer);
}

/**
 * Read animation files ([{ name, buffer }]) and group them by skeleton. Every group becomes one
 * pack: { base: scene of its first file, bones: Set, clips: [AnimationClip], files: [name] }.
 * `skipped` lists files without usable animation.
 */
export async function readAnimationFiles(files, { onProgress } = {}) {
  const groups = [];
  const skipped = [];
  for (const [k, f] of files.entries()) {
    onProgress?.(k, f.name);
    try {
      const g = await readAny(f.name, f.buffer);
      const take = mainTake(g.animations || []);
      if (!take || !take.tracks.length || !(take.duration > 0)) throw new Error('no animation in this file');
      const bones = boneNames(g.scene);
      if (bones.size < 10) throw new Error('no character skeleton in this file');
      // Same skeleton = (almost) the same bone names.
      let group = groups.find((x) => [...bones].filter((n) => !x.bones.has(n)).length <= 2);
      if (!group) groups.push((group = { base: g.scene, bones, clips: [], files: [] }));
      const clips = /\.fbx$/i.test(f.name) ? [take] : g.animations.filter((a) => a.tracks.length && a.duration > 0);
      for (const c of clips) {
        if (clips.length === 1) c.name = moveName(f.name);
        c.tracks = c.tracks.filter((t) => group.bones.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        group.clips.push(c);
      }
      group.files.push(f.name);
    } catch (e) {
      skipped.push({ name: f.name, error: e.message });
    }
  }
  return { groups, skipped };
}

/** Bone-name family of a pack, for a default pack name. */
export function packKind(bones) {
  return [...bones].some((n) => /^mixamorig/i.test(n)) ? 'Mixamo' : 'My';
}

/** Unique clip names; a later clip with the same name replaces the earlier one (re-download = update). */
function mergeClips(...lists) {
  const byName = new Map();
  for (const c of lists.flat()) byName.set(c.name, c);
  return [...byName.values()];
}

/** Give a skeleton-only scene an invisible skin so its joints stay bones in the GLB. */
function ensureSkin(scene) {
  if (scene.getObjectByProperty('isSkinnedMesh', true)) return;
  const bones = [];
  scene.traverse((o) => o.isBone && bones.push(o));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
  mesh.name = SKIN_ANCHOR;
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
}

/**
 * One pack GLB (ArrayBuffer) from a group, optionally merged into an existing pack (ArrayBuffer of
 * a .glb with the same skeleton): its character and clips are kept and the new clips are added.
 */
export async function buildPack(group, { mergeWith = null } = {}) {
  let scene = group.base;
  let clips = group.clips;
  if (mergeWith) {
    const old = await readGLTF(mergeWith);
    const missing = [...group.bones].filter((n) => !boneNames(old.scene).has(n));
    if (missing.length > 2) throw new Error(`different skeleton (${missing.length} bones not in the pack)`);
    scene = old.scene;
    clips = mergeClips(old.animations, group.clips);
  }
  ensureSkin(scene);
  return new GLTFExporter().parseAsync(scene, { binary: true, animations: clips, onlyVisible: false });
}
