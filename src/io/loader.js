// Loading GLB/GLTF characters and turning their animations into editable clips.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { analyzeRig } from '../core/rig.js';
import { clipFromThree, stripStaticChannels } from '../core/clip.js';
import { loopError } from '../core/analysis.js';

const loader = new GLTFLoader();

export async function readGLTF(source) {
  if (typeof source === 'string') return loader.loadAsync(source);
  return loader.parseAsync(source, '');
}

/**
 * FBX (e.g. Mixamo downloads) as a glTF-like { scene, animations } record. The FBX loader is
 * only fetched when needed.
 */
export async function readFBX(buffer) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const group = new FBXLoader().parse(buffer, '');
  // The FBX loader can nest a bone inside a node of the same name (Mixamo's Hips): the
  // animation drives the outer one by name while the skin uses the inner one. Fold the outer
  // transform into the inner bone so there is one Hips carrying both rest pose and motion.
  group.updateMatrixWorld(true);
  const dups = [];
  group.traverse((o) => o.isBone && o.name && o.parent?.name === o.name && dups.push(o));
  // (Mixamo's Y Bot even gets a copy of every bone, one per body mesh.)
  const replaced = new Map();
  for (const inner of dups) {
    const outer = inner.parent;
    outer.matrix.clone().multiply(inner.matrix).decompose(inner.position, inner.quaternion, inner.scale);
    const host = outer.parent;
    for (const c of [...outer.children]) if (c !== inner) inner.attach(c);
    host.add(inner);
    host.remove(outer);
    replaced.set(outer, inner);
  }
  // Skins that used the removed copies now use the surviving bone. Copies can be chained, so
  // anything a skin still points at that is no longer in the scene is matched by name.
  if (replaced.size) {
    const live = new Map();
    group.traverse((o) => o.isBone && !live.has(o.name) && live.set(o.name, o));
    const resolve = (b) => {
      let x = b;
      for (let k = 0; k < 10 && replaced.has(x); k++) x = replaced.get(x);
      let p = x;
      while (p && p !== group) p = p.parent;
      return p ? x : live.get(b.name) || x;
    };
    group.traverse((o) => o.isSkinnedMesh && (o.skeleton.bones = o.skeleton.bones.map(resolve)));
  }
  group.updateMatrixWorld(true);
  // Bones load in whatever pose the file was saved in (often a frame of the animation); the
  // skin's bind pose is the true rest pose (Mixamo: T-pose), which retargeting relies on.
  // FBX is usually in centimetres (a 1.8 m person is 180 units): convert to metres.
  const units = sceneHeight(group);
  if (units > 20) scaleScene(group, group.animations || [], 0.01);
  group.traverse((o) => o.isSkinnedMesh && o.skeleton.pose());
  group.updateMatrixWorld(true);
  await texturesLoaded(group);
  return { scene: group, animations: group.animations || [] };
}

function sceneHeight(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    } else if (o.isBone) box.expandByPoint(o.getWorldPosition(new THREE.Vector3()));
  });
  return box.isEmpty() ? 0 : box.max.y - box.min.y;
}

/** Uniformly scale a loaded scene (geometry, node offsets, skin bind data, position tracks). */
function scaleScene(group, animations, s) {
  const scaleT = (m) => ((m.elements[12] *= s), (m.elements[13] *= s), (m.elements[14] *= s));
  group.traverse((o) => {
    if (o !== group) o.position.multiplyScalar(s);
    if (o.isMesh) {
      o.geometry.scale(s, s, s);
      if (o.isSkinnedMesh) {
        scaleT(o.bindMatrix);
        o.bindMatrixInverse.copy(o.bindMatrix).invert();
        o.skeleton.boneInverses.forEach(scaleT);
      }
    }
  });
  for (const a of animations) for (const t of a.tracks) if (t.name.endsWith('.position')) for (let k = 0; k < t.values.length; k++) t.values[k] *= s;
  group.updateMatrixWorld(true);
}

/** FBX textures decode asynchronously; wait (up to 20 s) so the model can be saved with them. */
async function texturesLoaded(group, timeout = 20000) {
  const tex = new Set();
  group.traverse((o) => {
    for (const m of [].concat(o.material || [])) for (const v of Object.values(m)) if (v?.isTexture) tex.add(v);
  });
  const t0 = performance.now();
  const ready = (t) => {
    const img = t.image;
    return img && (img.complete === undefined || (img.complete && img.naturalWidth > 0) || img.width > 0);
  };
  while ([...tex].some((t) => !ready(t)) && performance.now() - t0 < timeout) await new Promise((r) => setTimeout(r, 100));
  // Textures that never arrived (missing external files) are dropped so saving still works.
  group.traverse((o) => {
    for (const m of [].concat(o.material || [])) for (const [k, v] of Object.entries(m)) if (v?.isTexture && !ready(v)) m[k] = null;
  });
}

/** Read a .glb/.gltf/.fbx from an ArrayBuffer. */
export const readModelFile = (buffer, name = '') => (/\.fbx$/i.test(name) ? readFBX(buffer) : readGLTF(buffer));

/**
 * Static models (props, weapons, doors…) have no skeleton. Give them one: a "Root" bone plus
 * one bone per separate part, with every vertex fully weighted to its part's bone. At rest the
 * model looks exactly the same, and each part (or the whole thing) can now be animated.
 * Existing object animations on top-level parts are renamed onto the new bones.
 */
function autoRig(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));
  if (!meshes.length) throw new Error('This file contains no meshes.');
  // A glTF node with several primitives becomes a Group of meshes: treat it as one part.
  const owners = new Map();
  for (const m of meshes) {
    const g = m.parent;
    const owner = g && g !== root && g.isGroup && g.children.every((c) => c.isMesh) ? g : m;
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(m);
  }
  // Bone names must not collide with any existing object name, or animation tracks could
  // bind to the mesh instead of the bone after export.
  const used = new Set();
  root.traverse((o) => o.name && used.add(o.name));
  const uname = (n) => {
    const base = THREE.PropertyBinding.sanitizeNodeName(n || '') || 'Part';
    let s = base,
      k = 2;
    while (used.has(s)) s = `${base}_${k++}`;
    used.add(s);
    return s;
  };
  const rootBone = new THREE.Bone();
  rootBone.name = uname('Root');
  root.add(rootBone);
  const bones = [rootBone];
  const rename = new Map();
  const boneOf = new Map();
  for (const owner of owners.keys()) {
    const bone = new THREE.Bone();
    bone.name = uname(`${owner.name || 'Part'}_bone`);
    inv.clone().multiply(owner.matrixWorld).decompose(bone.position, bone.quaternion, bone.scale);
    rootBone.add(bone);
    bones.push(bone);
    boneOf.set(owner, bone);
    if (owner.name && owner.parent === root) rename.set(owner.name, bone.name);
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const [owner, list] of owners) {
    const bi = bones.indexOf(boneOf.get(owner));
    for (const m of list) {
      const g = m.geometry;
      const n = g.attributes.position.count;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) {
        si[v * 4] = bi;
        sw[v * 4] = 1;
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      const sm = new THREE.SkinnedMesh(g, m.material);
      sm.name = m.name;
      inv.clone().multiply(m.matrixWorld).decompose(sm.position, sm.quaternion, sm.scale);
      for (const c of [...m.children]) root.attach(c);
      m.parent.remove(m);
      root.add(sm);
      sm.updateMatrixWorld(true);
      sm.bind(skeleton, sm.matrixWorld);
    }
  }
  for (const clip of gltf.animations) {
    for (const t of clip.tracks) {
      const dot = t.name.lastIndexOf('.');
      const node = t.name.slice(0, dot);
      if (rename.has(node)) t.name = rename.get(node) + t.name.slice(dot);
    }
  }
}

/** Invisible mesh that keeps a skin in skeleton-only animation packs (see io/packbuild.js). */
export const SKIN_ANCHOR = 'AnimStudio_SkeletonOnly';

/** Build the model record used everywhere in the app. */
export function buildModel(gltf, name, url = null) {
  const root = gltf.scene;
  let synthetic = false;
  // Skeleton-only files (Mixamo "Without Skin" downloads) are animation sources: bones, no mesh.
  const looseBones = [];
  root.traverse((o) => o.isBone && looseBones.push(o));
  const skeletonOnly = !root.getObjectByProperty('isSkinnedMesh', true) && looseBones.length >= 10;
  if (!skeletonOnly && !root.getObjectByProperty('isSkinnedMesh', true)) {
    autoRig(gltf);
    synthetic = true;
  }
  const meshes = [];
  let skinned = null;
  root.traverse((o) => {
    if (o.name === SKIN_ANCHOR) o.visible = false; // keeps the skeleton; not part of the body
    else if (o.isMesh) {
      meshes.push(o);
      o.frustumCulled = false;
      o.castShadow = true;
    }
    if (o.isSkinnedMesh && !skinned) skinned = o;
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
  }
  // Several skinned parts can each use a subset of the skeleton (e.g. a head mesh without the
  // legs): use every bone then, so the whole body is there.
  const skins = meshes.filter((m) => m.isSkinnedMesh);
  const partial = skins.some((m) => m.skeleton.bones.length !== skins[0].skeleton.bones.length || m.skeleton.bones.some((b, i) => b !== skins[0].skeleton.bones[i]));
  const bones = !skinned ? looseBones : partial ? looseBones : skinned.skeleton.bones;
  if (!meshes.length) {
    // No mesh: size the body from the joints (head top is ~10% above the highest joint).
    for (const b of bones) box.expandByPoint(b.getWorldPosition(new THREE.Vector3()));
    const h = box.max.y - box.min.y;
    box.max.y += h * 0.1;
    box.expandByVector(new THREE.Vector3(h * 0.05, 0, h * 0.05));
  }
  const rig = analyzeRig(root, bones, box);
  // Auto-made bones carry the part names, which read better than generic "Extra" labels.
  if (synthetic) {
    rig.labels = rig.labels.map(() => null);
    rig.group = rig.group.map(() => 'parts');
    rig.core = new Set(rig.bones.map((_, i) => i));
  }
  const parts = meshes.map((m, i) => ({ mesh: m, name: m.name && m.name !== 'Mesh' ? m.name : `Part ${i + 1}`, material: m.material }));
  return { name, url, gltf, root, meshes, skinned, bones, rig, box, parts, synthetic };
}

/** Editable clips from the file's animations (unique names, loop detection, static channels stripped). */
export function convertClips(model, animations = model.gltf.animations, { source = 'original' } = {}) {
  const names = new Set(model.rig.names);
  const used = new Set();
  return animations.map((tc) => {
    const c = clipFromThree(tc, names, { source });
    let n = c.name || 'clip',
      k = 2;
    while (used.has(n)) n = `${c.name}_${k++}`;
    used.add(n);
    c.name = n;
    if (source === 'original') c.meta.originalName = n;
    stripStaticChannels(c, model.rig);
    if (c.duration > 0) {
      const err = loopError(c, model.rig);
      c.loop = err.relative < 0.012 && err.angle < 6;
    }
    return c;
  });
}

/** Fraction of the target rig's bones that exist by name in a set of clips' tracks. */
export function nameMatch(rig, threeClips) {
  const names = new Set();
  for (const c of threeClips) for (const t of c.tracks) names.add(t.name.slice(0, t.name.lastIndexOf('.')));
  if (!names.size) return 0;
  let hit = 0;
  for (const n of names) if (rig.byName.has(n)) hit++;
  return hit / names.size;
}
