// ＋ Add animations: files people downloaded become one pack per skeleton (io/packbuild.js).
// The "downloads" are made here: a character rigged by AnimStudio, moving with generated gaits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, tPoseCharacter } from './helpers.js';
import { loadGlb } from './glb-node.js';
import { analyzeRig } from '../src/core/rig.js';
import { bakeToThree } from '../src/core/clip.js';
import { evalBone } from '../src/core/evaluate.js';
import { generateMotion } from '../src/core/gait.js';

// Minimal browser bits GLTFExporter needs in Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => ((this.result = b), this.onloadend?.(), this.onload?.({ target: this })));
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
      this.onload?.({ target: this });
    });
  }
};
globalThis.self ??= globalThis;

/** One downloaded file: the character with one move, as a .glb. */
async function download(type) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const { scene, rig } = tPoseCharacter();
  const clip = bakeToThree(generateMotion(rig, type), rig, evalBone, { fps: 30 });
  clip.name = 'Take 001';
  return { name: `${type[0].toUpperCase()}${type.slice(1)}.glb`, buffer: await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] }) };
}

function readPack(buffer) {
  const file = path.join(os.tmpdir(), `animstudio-pack-${process.pid}.glb`);
  fs.writeFileSync(file, Buffer.from(buffer));
  try {
    const g = loadGlb(file);
    return { ...g, rig: analyzeRig(g.scene, g.bones, g.box) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function downloadsBecomeOnePack() {
  const { readAnimationFiles, buildPack, packKind } = await import('../src/io/packbuild.js');
  const files = [await download('walk'), await download('run'), { name: 'notes.glb', buffer: new ArrayBuffer(8) }];
  const { groups, skipped } = await readAnimationFiles(files);
  assert(groups.length === 1, `one skeleton, one pack (${groups.length})`);
  assert(skipped.length === 1 && skipped[0].name === 'notes.glb', 'unreadable file reported');
  assert(groups[0].clips.map((c) => c.name).join() === 'Walk,Run', `moves named after the files: ${groups[0].clips.map((c) => c.name)}`);
  assert(packKind(groups[0].bones) === 'My', 'not a Mixamo skeleton');
  const pack = readPack(await buildPack(groups[0]));
  assert(pack.rig.humanoid, 'pack skeleton is a humanoid');
  assert(pack.clips.map((c) => c.name).join() === 'Walk,Run', 'both moves in the pack');
}

export async function addingToAPackReplacesSameNames() {
  const { readAnimationFiles, buildPack } = await import('../src/io/packbuild.js');
  const first = await buildPack((await readAnimationFiles([await download('walk'), await download('run')])).groups[0]);
  // Later: run again (a new download of the same move) plus sneak.
  const more = (await readAnimationFiles([await download('run'), await download('sneak')])).groups[0];
  const pack = readPack(await buildPack(more, { mergeWith: first }));
  assert(pack.clips.map((c) => c.name).sort().join() === 'Run,Sneak,Walk', `merged without duplicates: ${pack.clips.map((c) => c.name)}`);
}

export async function skeletonOnlyFilesKeepTheirBones() {
  // Mixamo "Without Skin" downloads: bones and motion, no mesh.
  const { readAnimationFiles, buildPack } = await import('../src/io/packbuild.js');
  const { SKIN_ANCHOR } = await import('../src/io/loader.js');
  const { groups } = await readAnimationFiles([await download('walk')]);
  const meshes = [];
  groups[0].base.traverse((o) => o.isMesh && meshes.push(o));
  meshes.forEach((m) => m.removeFromParent());
  const pack = readPack(await buildPack(groups[0]));
  assert(pack.bones.length >= 20 && pack.rig.humanoid, `bones kept (${pack.bones.length})`);
  assert(pack.json.nodes.some((n) => n.name === SKIN_ANCHOR), 'invisible skin anchor added');
}
