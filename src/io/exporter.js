// GLB export: bake clips (layers, smooth curves) to linear tracks and write a binary glTF.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { bakeToThree, cloneClip } from '../core/clip.js';
import { evalBone, applyRest } from '../core/evaluate.js';
import { reduceChannel, rootMotion, bakeLayers } from '../core/ops.js';
import { rootBone, extractRootMotion } from '../core/rootmotion.js';
import { footReport } from '../core/contacts.js';

const DEG = Math.PI / 180;

/**
 * The name a clip gets in the file. With a loop suffix (Godot: "-loop"), looping clips get it,
 * unless their name already says so ("Walk_Loop"); Godot then loops them and drops the suffix.
 */
export function exportClipName(clip, loopSuffix = '') {
  return loopSuffix && clip.loop && !/[-_ ]?(loop|cycle)$/i.test(clip.name) ? clip.name + loopSuffix : clip.name;
}

/**
 * @param model   loaded model record
 * @param clips   clips to include
 * @param opts    { fps, reduce (deg, 0 = exact), includeMesh, onlyVisible, fillRest,
 *                  rootMotion: 'keep' | 'inplace' (no travel) | 'root' (travel on the root bone),
 *                  inPlace (old name for rootMotion 'inplace'), loopSuffix ('-loop' for Godot),
 *                  feetAtOrigin: move the character so its feet are at y = 0 (default true) }
 * @returns ArrayBuffer (GLB)
 */
export async function exportGLB(model, clips, opts = {}) {
  const { fps = 30, reduce = 0, includeMesh = true, onlyVisible = true, fillRest = true, inPlace = false, loopSuffix = '', feetAtOrigin = true } = opts;
  const travel = opts.rootMotion || (inPlace ? 'inplace' : 'keep');
  const rig = model.rig;
  const posTol = rig.height * 0.0005;
  const reducer = (ch, tolDeg) => reduceChannel(ch, ch.type === 'rot' ? tolDeg * DEG : posTol * (tolDeg / 0.5));

  const threeClips = clips.map((c) => {
    let src = c;
    if (travel !== 'keep') {
      src = cloneClip(c);
      if (travel === 'inplace') rootMotion(src, { rig }, { mode: 'inplace' });
      else if (travel === 'root' && rootBone(rig) >= 0) {
        // On the motion the game sees: all layers merged first.
        if (src.layers.length > 1) bakeLayers(src, { rig }, { fps });
        extractRootMotion(src, { rig }, { fps });
      }
    }
    const tc = bakeToThree(src, rig, evalBone, { fps, reduce, reducer: reduce > 0 ? reducer : null });
    tc.name = exportClipName(c, loopSuffix);
    return tc;
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
  // Engines stand a character on its origin. Many models (e.g. Meshy) have it in the middle of
  // the body, so they would sink into or hover above the floor: put the feet at y = 0.
  exportRoot.updateMatrix();
  const lift = feetAtOrigin ? -new THREE.Vector3(0, rig.ground, 0).applyMatrix4(exportRoot.matrix).y : 0; // through the root's own scale/offset
  exportRoot.position.y += lift;
  try {
    return await new GLTFExporter().parseAsync(scene, { binary: true, trs: true, onlyVisible, animations: threeClips });
  } finally {
    exportRoot.position.y -= lift;
    if (includeMesh && prevParent) prevParent.add(model.root);
    model.parts.forEach((p, i) => (p.mesh.material = swapped[i]));
  }
}

/**
 * Sidecar with clip metadata for game code: loop flags, events, and for moves with steps the speed
 * to move the character at (m/s) so its feet don't slide in the game.
 */
export function eventsSidecar(model, clips, { loopSuffix = '', rootMotion = 'keep', fps = 30 } = {}) {
  const rig = model.rig;
  const feet = !!(rig.ik['foot.L'] || rig.ik['foot.R']);
  return {
    model: model.name,
    generator: 'AnimStudio',
    rootMotion: rootMotion === 'root' && rootBone(rig) >= 0 ? rig.names[rootBone(rig)] : null,
    clips: clips.map((c) => {
      const out = { name: exportClipName(c, loopSuffix), duration: +c.duration.toFixed(4), loop: !!c.loop, events: c.events.map((e) => ({ time: +e.t.toFixed(4), name: e.name })) };
      if (out.name !== c.name) out.editorName = c.name;
      if (feet && c.duration > 0) {
        const r = footReport(c, rig, { fps });
        if (r.speed > 0.05) Object.assign(out, { speed: +r.speed.toFixed(3), inPlace: r.inPlace });
      }
      return out;
    }),
  };
}
