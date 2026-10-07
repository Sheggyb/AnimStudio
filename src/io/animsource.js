// Animation sources: other models' skeletons + clips, loaded without meshes or textures
// (much faster than a full GLTFLoader pass). Used by the Move Maker library and retargeting.
import * as THREE from 'three';
import { analyzeRig } from '../core/rig.js';
import { convertClips } from './loader.js';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Parse a GLB's node hierarchy, skin joints, mesh bounds and animations. */
export function parseGlbAnimations(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const accessor = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const comps = COMPONENTS[a.type];
    const T = TYPED[a.componentType];
    const elem = T.BYTES_PER_ELEMENT;
    const stride = bv.byteStride || comps * elem;
    const base = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float32Array(a.count * comps);
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < comps; c++) {
        const off = base + i * stride + c * elem;
        let v;
        switch (a.componentType) {
          case 5126: v = dv.getFloat32(off, true); break;
          case 5122: v = dv.getInt16(off, true); break;
          case 5123: v = dv.getUint16(off, true); break;
          case 5120: v = dv.getInt8(off); break;
          case 5121: v = dv.getUint8(off); break;
          default: v = dv.getUint32(off, true);
        }
        if (a.normalized && NORM[a.componentType]) v = Math.max(v / NORM[a.componentType], -1);
        out[i * comps + c] = v;
      }
    return out;
  };
  const joints = new Set(json.skins?.[0]?.joints || []);
  const objs = json.nodes.map((nd, i) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = THREE.PropertyBinding.sanitizeNodeName(nd.name || `node_${i}`);
    if (nd.matrix) new THREE.Matrix4().fromArray(nd.matrix).decompose(o.position, o.quaternion, o.scale);
    if (nd.translation) o.position.fromArray(nd.translation);
    if (nd.rotation) o.quaternion.fromArray(nd.rotation);
    if (nd.scale) o.scale.fromArray(nd.scale);
    return o;
  });
  json.nodes.forEach((nd, i) => (nd.children || []).forEach((c) => objs[i].add(objs[c])));
  const scene = new THREE.Group();
  for (const i of json.scenes?.[json.scene || 0]?.nodes || []) scene.add(objs[i]);
  scene.updateMatrixWorld(true);
  const bones = (json.skins?.[0]?.joints || []).map((i) => objs[i]);
  // Mesh bounds in model space (POSITION min/max transformed by the mesh node).
  const box = new THREE.Box3();
  json.nodes.forEach((nd, i) => {
    if (nd.mesh === undefined) return;
    for (const prim of json.meshes[nd.mesh].primitives) {
      const a = json.accessors[prim.attributes.POSITION];
      if (!a?.min) continue;
      const b = new THREE.Box3(new THREE.Vector3(...a.min), new THREE.Vector3(...a.max));
      box.union(nd.skin !== undefined ? b : b.applyMatrix4(objs[i].matrixWorld));
    }
  });
  const PROP = { rotation: 'quaternion', translation: 'position', scale: 'scale' };
  const animations = (json.animations || []).map((an, k) => {
    const tracks = [];
    for (const ch of an.channels) {
      const s = an.samplers[ch.sampler];
      const prop = PROP[ch.target.path];
      if (!prop || ch.target.node === undefined) continue;
      const T = prop === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      let values = accessor(s.output);
      const times = accessor(s.input);
      if (s.interpolation === 'CUBICSPLINE') {
        // keep only the spline vertices (drop tangents)
        const size = values.length / times.length / 3;
        const v = new Float32Array(times.length * size);
        for (let i = 0; i < times.length; i++) v.set(values.subarray(i * size * 3 + size, i * size * 3 + 2 * size), i * size);
        values = v;
      }
      const tr = new T(`${objs[ch.target.node].name}.${prop}`, times, values);
      if (s.interpolation === 'STEP') tr.setInterpolation(THREE.InterpolateDiscrete);
      tracks.push(tr);
    }
    return new THREE.AnimationClip(an.name || `clip_${k}`, -1, tracks);
  });
  return { json, scene, bones, box, animations };
}

const cache = new Map();

/** Load (and cache) another model's rig + clips as an animation source. */
export async function loadAnimSource(url, name) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const buf = await (await fetch(url)).arrayBuffer();
    const g = parseGlbAnimations(buf);
    if (!g.bones.length) throw new Error(`${name} has no skeleton`);
    const rig = analyzeRig(g.scene, g.bones, g.box.isEmpty() ? null : g.box);
    const clips = convertClips({ rig, gltf: { animations: g.animations } }, g.animations);
    return { name, url, rig, clips, byName: new Map(clips.map((c) => [c.name, c])) };
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
