// GLB export: bake clips (layers, smooth curves) to linear tracks and write a binary glTF.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { bakeToThree, cloneClip } from '../core/clip.js';
import { evalBone, applyRest } from '../core/evaluate.js';
import { reduceChannel, rootMotion } from '../core/ops.js';

const DEG = Math.PI / 180;

/**
 * @param model   loaded model record
 * @param clips   clips to include
 * @param opts    { fps, reduce (deg, 0 = exact), includeMesh, onlyVisible, fillRest, inPlace }
 * @returns ArrayBuffer (GLB)
 */
export async function exportGLB(model, clips, opts = {}) {
  const { fps = 30, reduce = 0, includeMesh = true, onlyVisible = true, fillRest = true, inPlace = false } = opts;
  const rig = model.rig;
  const posTol = rig.height * 0.0005;
  const reducer = (ch, tolDeg) => reduceChannel(ch, ch.type === 'rot' ? tolDeg * DEG : posTol * (tolDeg / 0.5));

  const threeClips = clips.map((c) => {
    let src = c;
    if (inPlace) {
      src = cloneClip(c);
      rootMotion(src, { rig }, { mode: 'inplace' });
    }
    return bakeToThree(src, rig, evalBone, { fps, reduce, reducer: reduce > 0 ? reducer : null });
  });

  if (fillRest && threeClips.length > 1) {
    // Engines don't reset bones a clip doesn't animate; key the rest pose so clips never "leak".
    const all = new Set();
    for (const tc of threeClips) for (const tr of tc.tracks) all.add(tr.name);
    for (const tc of threeClips) {
      const have = new Set(tc.tracks.map((t) => t.name));
      for (const name of all) {
        if (have.has(name)) continue;
        const dot = name.lastIndexOf('.');
        const r = rig.rest[rig.byName.get(name.slice(0, dot))];
        if (!r) continue;
        const prop = name.slice(dot + 1);
        const v = prop === 'quaternion' ? r.q.toArray() : prop === 'position' ? r.p.toArray() : r.s.toArray();
        const T = prop === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
        const d = Math.max(tc.duration, 1 / fps);
        tc.tracks.push(new T(name, [0, d], [...v, ...v]));
      }
    }
  }

  // Export from the rest pose with the original materials.
  applyRest(rig);
  const swapped = model.parts.map((p) => {
    const cur = p.mesh.material;
    p.mesh.material = p.material;
    return cur;
  });
  model.root.updateMatrixWorld(true);

  const scene = new THREE.Scene();
  let exportRoot;
  const prevParent = model.root.parent;
  if (includeMesh) {
    exportRoot = model.root;
    scene.add(exportRoot);
  } else {
    exportRoot = SkeletonUtils.clone(model.root);
    const meshes = [];
    exportRoot.traverse((o) => o.isMesh && meshes.push(o));
    meshes.forEach((m) => m.parent.remove(m));
    scene.add(exportRoot);
  }
  try {
    return await new GLTFExporter().parseAsync(scene, { binary: true, trs: true, onlyVisible, animations: threeClips });
  } finally {
    if (includeMesh && prevParent) prevParent.add(model.root);
    model.parts.forEach((p, i) => (p.mesh.material = swapped[i]));
  }
}

/** Sidecar with clip metadata (loop flags, events) for game code. */
export function eventsSidecar(model, clips) {
  return {
    model: model.name,
    generator: 'AnimStudio',
    clips: clips.map((c) => ({ name: c.name, duration: +c.duration.toFixed(4), loop: !!c.loop, events: c.events.map((e) => ({ time: +e.t.toFixed(4), name: e.name })) })),
  };
}
