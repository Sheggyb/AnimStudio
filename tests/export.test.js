// Export for game engines: Godot loop names, root motion on the root bone, the sidecar (no downloads needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, tPoseCharacter } from './helpers.js';
import { loadGlb } from './glb-node.js';
import { generateMotion } from '../src/core/gait.js';
import { bodyOffsetLocal } from '../src/core/anatomy.js';
import { exportGLB, eventsSidecar, exportClipName } from '../src/io/exporter.js';

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

function readGlb(buffer) {
  const file = path.join(os.tmpdir(), `animstudio-export-${process.pid}.glb`);
  fs.writeFileSync(file, Buffer.from(buffer));
  try {
    return loadGlb(file);
  } finally {
    fs.unlinkSync(file);
  }
}

const range = (values, axis) => {
  let lo = Infinity,
    hi = -Infinity;
  for (let k = axis; k < values.length; k += 3) (lo = Math.min(lo, values[k])), (hi = Math.max(hi, values[k]));
  return hi - lo;
};

export async function engineExportNamesAndRootMotion() {
  const { scene, mesh, rig } = tPoseCharacter();
  const model = { name: 'Box.glb', rig, root: scene, parts: [{ mesh, material: mesh.material }] };
  const walk = generateMotion(rig, 'walk', { name: 'Walk' }); // loops
  const run = generateMotion(rig, 'run', { name: 'Run_Loop' }); // already says it loops
  // A one-shot move that travels a metre forward on the hips.
  const dash = generateMotion(rig, 'jog', { name: 'Dash', plant: false });
  dash.loop = false;
  const h = rig.special.hips;
  const pos = dash.layers[0].tracks[rig.names[h]].pos;
  for (let k = 0; k < pos.times.length; k++) {
    const off = bodyOffsetLocal(rig, h, [0, 0, pos.times[k] / dash.duration]).sub(rig.rest[h].p);
    for (let a = 0; a < 3; a++) pos.values[k * 3 + a] += off.getComponent(a);
  }
  const clips = [walk, run, dash];
  const g = readGlb(await exportGLB(model, clips, { rootMotion: 'root', loopSuffix: '-loop' }));
  const names = g.clips.map((c) => c.name);
  assert(names.join() === 'Walk-loop,Run_Loop,Dash', `Godot loop names: ${names.join(', ')}`);
  const fwd = rig.forwardAxis === 'x' ? 0 : 2;
  const exported = g.clips.find((c) => c.name === 'Dash');
  const rootTrack = exported.tracks.find((t) => t.name === 'Root.position');
  const hipsTrack = exported.tracks.find((t) => t.name === `${rig.names[h]}.position`);
  assert(rootTrack && Math.abs(range(rootTrack.values, fwd) - 1) < 0.05, `the travel is on the root (${rootTrack ? range(rootTrack.values, fwd).toFixed(3) : 'no track'} m)`);
  assert(hipsTrack && range(hipsTrack.values, fwd) < 0.15, `the hips only sway over the root (${hipsTrack ? range(hipsTrack.values, fwd).toFixed(3) : 'no track'} m)`);

  const side = eventsSidecar(model, clips, { loopSuffix: '-loop', rootMotion: 'root' });
  assert(side.rootMotion === 'Root', 'sidecar names the root motion bone');
  assert(side.clips.map((c) => c.name).join() === names.join(), 'sidecar names match the file');
  const w = side.clips[0];
  assert(w.editorName === 'Walk' && w.loop && w.inPlace && w.speed > 0.2 && w.speed < 3, `walk: in place at ${w.speed} m/s`);
  assert(exportClipName(walk) === 'Walk', 'no suffix unless asked');
}
