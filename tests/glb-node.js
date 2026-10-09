// Minimal GLB reader for Node tests: builds the node hierarchy (THREE.Bone for joints),
// mesh bounds and animation clips — no textures, no WebGL.
import fs from 'node:fs';
import * as THREE from 'three';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function loadGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binHeader = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = buf.buffer.slice(buf.byteOffset + binHeader + 8, buf.byteOffset + binHeader + 8 + binLen);

  const accessor = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const comps = COMPONENTS[a.type];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (a.componentType !== 5126) throw new Error('Only float accessors supported in tests');
    if (bv.byteStride && bv.byteStride !== comps * 4) throw new Error('Interleaved accessors not supported in tests');
    return new Float32Array(bin.slice(off, off + a.count * comps * 4));
  };

  // Every skin's joints (a character can be split into skins that each use part of the skeleton).
  const joints = new Set((json.skins || []).flatMap((sk) => sk.joints));
  const objs = json.nodes.map((nd, i) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = nd.name || `node_${i}`;
    if (nd.translation) o.position.fromArray(nd.translation);
    if (nd.rotation) o.quaternion.fromArray(nd.rotation);
    if (nd.scale) o.scale.fromArray(nd.scale);
    return o;
  });
  json.nodes.forEach((nd, i) => (nd.children || []).forEach((c) => objs[i].add(objs[c])));
  const scene = new THREE.Group();
  (json.scenes[json.scene || 0].nodes || []).forEach((i) => scene.add(objs[i]));
  scene.updateMatrixWorld(true);
  const bones = [...joints].map((i) => objs[i]);

  // Mesh bounds in model space (through each mesh node's transform; at rest a skinned mesh
  // sits where its node puts it).
  const box = new THREE.Box3();
  json.nodes.forEach((nd, i) => {
    if (nd.mesh === undefined) return;
    for (const p of json.meshes[nd.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION];
      if (a.min && a.max) box.union(new THREE.Box3(new THREE.Vector3(...a.min), new THREE.Vector3(...a.max)).applyMatrix4(objs[i].matrixWorld));
    }
  });

  const PROP = { rotation: 'quaternion', translation: 'position', scale: 'scale' };
  const clips = (json.animations || []).map((an, k) => {
    const tracks = [];
    for (const ch of an.channels) {
      const s = an.samplers[ch.sampler];
      const prop = PROP[ch.target.path];
      if (!prop) continue;
      const T = prop === 'quaternion' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
      const tr = new T(`${objs[ch.target.node].name}.${prop}`, accessor(s.input), accessor(s.output));
      if (s.interpolation === 'STEP') tr.setInterpolation(THREE.InterpolateDiscrete);
      tracks.push(tr);
    }
    return new THREE.AnimationClip(an.name || `anim_${k}`, -1, tracks);
  });
  return { json, scene, bones, box, clips };
}
