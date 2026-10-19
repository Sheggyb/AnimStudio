// BVH motion capture: read, sized to metres, stood up when Z-up, retargeted (no downloads needed).
import { assert, tPoseCharacter } from './helpers.js';
import { readBVH, buildModel, convertClips } from '../src/io/loader.js';
import { readAnimationFiles } from '../src/io/packbuild.js';
import { retargetClip } from '../src/core/retarget.js';
import { evalWorld } from '../src/core/evaluate.js';

// A CMU-style skeleton in centimetres: [name, parent, offset].
const JOINTS = [
  ['Hips', null, [0, 95, 0]],
  ['Spine', 'Hips', [0, 12, 0]],
  ['Spine1', 'Spine', [0, 15, 0]],
  ['Neck', 'Spine1', [0, 20, 0]],
  ['Head', 'Neck', [0, 10, 2]],
];
for (const [s, x] of [['Left', 1], ['Right', -1]]) {
  JOINTS.push(
    [`${s}Shoulder`, 'Spine1', [5 * x, 17, 0]],
    [`${s}Arm`, `${s}Shoulder`, [12 * x, 0, 0]],
    [`${s}ForeArm`, `${s}Arm`, [27 * x, 0, 0]],
    [`${s}Hand`, `${s}ForeArm`, [25 * x, 0, 0]],
    [`${s}UpLeg`, 'Hips', [9 * x, -5, 0]],
    [`${s}Leg`, `${s}UpLeg`, [0, -43, 0]],
    [`${s}Foot`, `${s}Leg`, [0, -42, 0]],
    [`${s}ToeBase`, `${s}Foot`, [0, -5, 12]]
  );
}
const LEAVES = new Set(['Head', 'LeftHand', 'RightHand', 'LeftToeBase', 'RightToeBase']);

/** A BVH file: the skeleton above, walking (the thighs swing) for one second at 30 fps. */
function makeBVH({ zUp = false } = {}) {
  const v = ([x, y, z]) => (zUp ? [x, -z, y] : [x, y, z]).map((n) => n.toFixed(2)).join(' ');
  const kids = (name) => JOINTS.filter((j) => j[1] === name);
  const lines = ['HIERARCHY'];
  const order = [];
  const write = ([name, , off], depth) => {
    const pad = '  '.repeat(depth);
    lines.push(`${pad}${depth ? 'JOINT' : 'ROOT'} ${name}`, `${pad}{`, `${pad}  OFFSET ${v(off)}`);
    lines.push(`${pad}  CHANNELS ${depth ? '3 Zrotation Xrotation Yrotation' : '6 Xposition Yposition Zposition Zrotation Xrotation Yrotation'}`);
    order.push(name);
    for (const c of kids(name)) write(c, depth + 1);
    if (LEAVES.has(name)) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${v([0, name === 'Head' ? 18 : -6, 0])}`, `${pad}  }`);
    lines.push(`${pad}}`);
  };
  write(JOINTS[0], 0);
  const frames = 31;
  lines.push('MOTION', `Frames: ${frames}`, 'Frame Time: 0.0333333');
  for (let f = 0; f < frames; f++) {
    const swing = 25 * Math.sin((f / (frames - 1)) * Math.PI * 2);
    const row = [];
    for (const name of order) {
      if (name === 'Hips') row.push(...v([0, 95, 0]).split(' '));
      const x = name === 'LeftUpLeg' ? swing : name === 'RightUpLeg' ? -swing : 0;
      row.push('0', x.toFixed(3), '0'); // Z X Y
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

export async function bvhIsReadAsAHumanoidInMetres() {
  const g = await readBVH(new TextEncoder().encode(makeBVH()).buffer);
  const model = buildModel(g, 'walk.bvh');
  const rig = model.rig;
  assert(rig.humanoid, 'humanoid recognised from the CMU names');
  assert(rig.height > 1.5 && rig.height < 2, `about a person tall in metres (${rig.height.toFixed(2)} m)`);
  const ends = rig.names.filter((n) => /_End/.test(n));
  assert(ends.length === 5 && new Set(ends).size === 5 && !rig.names.includes('ENDSITE'), `end sites named: ${ends.join(', ')}`);
  const [clip] = convertClips(model);
  assert(clip && clip.duration > 0.9, 'one clip');
  const thigh = rig.byKind.get('thigh.L');
  const q0 = evalWorld(clip, 0.25, rig).wq[thigh].clone();
  const q1 = evalWorld(clip, 0.75, rig).wq[thigh].clone();
  assert((q0.angleTo(q1) * 180) / Math.PI > 40, 'the thigh swings');
  // Onto a character AnimStudio rigged.
  const dst = tPoseCharacter().rig;
  const { clip: out, mapped } = retargetClip(clip, rig, dst, { mode: 'auto' });
  assert(mapped >= 14, `${mapped} bones matched`);
  const a = evalWorld(out, 0.25, dst).wq[dst.byKind.get('thigh.L')].clone();
  const b = evalWorld(out, 0.75, dst).wq[dst.byKind.get('thigh.L')];
  assert((a.angleTo(b) * 180) / Math.PI > 30, 'and swings on the character too');
}

export async function zUpBvhStandsUp() {
  const g = await readBVH(makeBVH({ zUp: true }));
  const rig = buildModel(g, 'zup.bvh').rig;
  assert(rig.height > 1.5 && rig.height < 2, `stood up: ${rig.height.toFixed(2)} m tall`);
  const head = rig.restWorld.p[rig.special.head ?? rig.byKind.get('head')];
  const foot = rig.restWorld.p[rig.byKind.get('foot.L')];
  assert(head.y > foot.y + 1, 'head above the feet');
}

export async function bvhFilesBecomeAPack() {
  const files = ['Walk A.bvh', 'Walk B.bvh'].map((name) => ({ name, buffer: new TextEncoder().encode(makeBVH()).buffer }));
  const { groups, skipped } = await readAnimationFiles(files);
  assert(!skipped.length, 'nothing skipped: ' + skipped.map((s) => s.error).join(', '));
  assert(groups.length === 1 && groups[0].clips.map((c) => c.name).join() === 'Walk_A,Walk_B', 'one pack, a move per file');
}
