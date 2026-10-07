import * as THREE from 'three';
import { assert, tPoseCharacter } from './helpers.js';
import { evalWorld } from '../src/core/evaluate.js';
import { makeClip, getTrack } from '../src/core/clip.js';
import { setKey } from '../src/core/channel.js';
import { generateMotion } from '../src/core/gait.js';
import { standardRig } from '../src/core/standard.js';
import { retargetClip } from '../src/core/retarget.js';
import { landmarksToClip, cycleAverage, LM } from '../src/core/videomotion.js';

/** Fake MediaPipe landmarks from a clip on the standard rig (what a perfect tracker would see). */
function fakeTrack(clip, { fps = 30, turn = 0, repeat = 1, noise = 0 } = {}) {
  const rig = standardRig();
  const id = (n) => rig.names.indexOf(n);
  const frames = [];
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn);
  const n = Math.round(clip.duration * fps * repeat) + 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  for (let f = 0; f < n; f++) {
    const w = evalWorld(clip, (f / fps) % clip.duration, rig);
    const P = (nm) => w.wp[id(nm)].clone();
    const Q = (nm) => w.wq[id(nm)];
    const off = (nm, v) => P(nm).add(new THREE.Vector3(...v).applyQuaternion(Q(nm)));
    const pts = new Array(33).fill(null);
    const set = (j, v) => (pts[j] = v);
    for (const [s, sg] of [['L', 1], ['R', -1]]) {
      set(LM[`sh${s}`], P(`UpperArm_${s}`));
      set(LM[`el${s}`], P(`ForeArm_${s}`));
      set(LM[`wr${s}`], P(`Hand_${s}`));
      set(LM[`in${s}`], off(`Hand_${s}`, [0.01, -0.09, 0.04]));
      set(LM[`pi${s}`], off(`Hand_${s}`, [0.01, -0.09, -0.04]));
      set(LM[`hip${s}`], P(`Thigh_${s}`));
      set(LM[`kn${s}`], P(`Calf_${s}`));
      set(LM[`an${s}`], P(`Foot_${s}`));
      set(LM[`he${s}`], off(`Foot_${s}`, [0, -0.06, -0.05]));
      set(LM[`to${s}`], P(`Toe_End_${s}`));
      set(LM[`ear${s}`], off('Head', [sg * 0.08, 0.04, 0]));
    }
    set(LM.nose, off('Head', [0, 0.04 - 0.3 * 0.1, 0.1]));
    const hipMid = pts[LM.hipL].clone().add(pts[LM.hipR]).multiplyScalar(0.5);
    const world = pts.map((p) => {
      if (!p) return [0, 0, 0, 0];
      const v = p.clone().sub(hipMid).applyQuaternion(yaw);
      return [v.x + rnd(), -v.y + rnd(), -v.z + rnd(), 1];
    });
    // A simple front camera for the image points: 1 m = 400 px, floor near the bottom.
    const image = pts.map((p) => (p ? [(320 + p.applyQuaternion(yaw).x * 400) / 640, (460 - p.y * 400) / 480, 0, 1] : [0, 0, 0, 0]));
    frames.push({ world, image });
  }
  return { fps, width: 640, height: 480, frames };
}

// Test moves on the standard rig, made by AnimStudio itself (no downloaded animation data).
const STD = standardRig();
const keyed = (name, duration, keys) => {
  const c = makeClip(name, duration);
  for (const [bone, type, t, v] of keys) setKey(getTrack(c.layers[0], bone, type, true), t, v);
  return c;
};
const rest = (bone) => STD.rest[STD.names.indexOf(bone)];
const turned = (bone, axis, rad) => rest(bone).q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), rad)).toArray();
const MOVES = {
  run: () => generateMotion(STD, 'run'),
  march: () => generateMotion(STD, 'march'),
  sneak: () => generateMotion(STD, 'sneak'),
  /** The whole body goes up 35 cm and comes back down. */
  jump: () => {
    const p = rest('Hips').p;
    return keyed('Jump', 1, [0, 0.5, 1].map((t, k) => ['Hips', 'pos', t, [p.x, p.y + (k === 1 ? 0.35 : 0), p.z]]));
  },
  /** One-off: the right arm sweeps up once and stays there (not a cycle). */
  reach: () =>
    keyed('Reach', 1.6, [
      ['UpperArm_R', 'rot', 0, rest('UpperArm_R').q.toArray()],
      ['UpperArm_R', 'rot', 1.0, turned('UpperArm_R', [1, 0, 0], -2.2)],
      ['UpperArm_R', 'rot', 1.6, turned('UpperArm_R', [1, 0, 0], -2.2)],
      ['Spine', 'rot', 0, rest('Spine').q.toArray()],
      ['Spine', 'rot', 1.6, turned('Spine', [0, 1, 0], 0.5)],
    ]),
};
const loadMove = (name) => MOVES[name]();

function limbError(a, b) {
  const rig = standardRig();
  const id = (n) => rig.names.indexOf(n);
  const pairs = ['L', 'R'].flatMap((s) => [[`UpperArm_${s}`, `ForeArm_${s}`], [`ForeArm_${s}`, `Hand_${s}`], [`Thigh_${s}`, `Calf_${s}`], [`Calf_${s}`, `Foot_${s}`], [`Foot_${s}`, `Toe_End_${s}`]]);
  pairs.push(['Hips', 'Neck']);
  let worst = 0;
  let sum = 0;
  let cnt = 0;
  const n = Math.round(a.duration * 30);
  for (let f = 0; f <= n; f += 2) {
    const wa = evalWorld(a, f / 30, rig);
    const wb = evalWorld(b, f / 30, rig);
    for (const [p, c] of pairs) {
      const da = wa.wp[id(c)].clone().sub(wa.wp[id(p)]);
      const db = wb.wp[id(c)].clone().sub(wb.wp[id(p)]);
      const e = (da.angleTo(db) * 180) / Math.PI;
      worst = Math.max(worst, e);
      sum += e;
      cnt++;
    }
  }
  return { worst, mean: sum / cnt };
}

/** A perfectly tracked move comes back with the same limb directions. */
export function videoRoundTrip() {
  for (const file of ['run', 'march', 'sneak']) {
    const src = loadMove(file);
    const { clip, info } = landmarksToClip(fakeTrack(src), { smooth: 0 });
    assert(info.legs && info.arms, `${file}: limbs detected`);
    const e = limbError(src, clip);
    assert(e.mean < 4 && e.worst < 25, `${file}: limb directions match (mean ${e.mean.toFixed(1)}°, worst ${e.worst.toFixed(1)}°)`);
  }
}

/** Filmed from the side: "face forward" turns the character back to the front. */
export function videoFaceForward() {
  const src = loadMove('run');
  const { clip } = landmarksToClip(fakeTrack(src, { turn: Math.PI / 2 }), { smooth: 0 });
  const e = limbError(src, clip);
  assert(e.mean < 6, `side view straightened (mean ${e.mean.toFixed(1)}°)`);
}

/** Jumps found from the image lift the hips; standing stays on the ground. */
export function videoJumpHeight() {
  const src = loadMove('jump');
  const { clip } = landmarksToClip(fakeTrack(src), { smooth: 0 });
  const rig = standardRig();
  const hips = rig.names.indexOf('Hips');
  let maxA = -Infinity, maxB = -Infinity;
  for (let f = 0; f <= Math.round(src.duration * 30); f++) {
    maxA = Math.max(maxA, evalWorld(src, f / 30, rig).wp[hips].y);
    maxB = Math.max(maxB, evalWorld(clip, f / 30, rig).wp[hips].y);
  }
  assert(Math.abs(maxA - maxB) < 0.12, `jump height kept (${maxA.toFixed(2)} vs ${maxB.toFixed(2)})`);
}

/** The captured clip retargets onto the user's T-posed character with arms that follow. */
export function videoOnCharacter() {
  const { rig } = tPoseCharacter();
  const { clip } = landmarksToClip(fakeTrack(loadMove('run')), {});
  const out = retargetClip(clip, standardRig(), rig, { mode: 'auto' }).clip;
  const w = evalWorld(out, out.duration * 0.3, rig);
  for (const s of ['L', 'R']) {
    const d = w.wp[rig.byKind.get(`forearm.${s}`)].clone().sub(w.wp[rig.byKind.get(`upperarm.${s}`)]);
    const side = (Math.atan2(Math.abs(d.x), -d.y) * 180) / Math.PI;
    assert(side < 45, `${s} arm hangs (${side.toFixed(0)}° from vertical)`);
  }
}

/** Mean limb-direction error between `a` and the loop `b` started `off` seconds later. */
function phaseError(a, b, off) {
  const rig = standardRig();
  const id = (n) => rig.names.indexOf(n);
  const pairs = ['L', 'R'].flatMap((s) => [[`UpperArm_${s}`, `ForeArm_${s}`], [`Thigh_${s}`, `Calf_${s}`], [`Calf_${s}`, `Foot_${s}`]]);
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < 12; k++) {
    const t = (k / 12) * a.duration;
    const wa = evalWorld(a, t, rig);
    const wb = evalWorld(b, (((t + off) % b.duration) + b.duration) % b.duration, rig);
    for (const [p, c] of pairs) {
      sum += (wa.wp[id(c)].clone().sub(wa.wp[id(p)]).angleTo(wb.wp[id(c)].clone().sub(wb.wp[id(p)])) * 180) / Math.PI;
      cnt++;
    }
  }
  return sum / cnt;
}

/** A noisy capture of several run cycles averages into one cycle of the right length, closer to the truth. */
export function videoCycleAverage() {
  const src = loadMove('run');
  const { clip: noisy } = landmarksToClip(fakeTrack(src, { repeat: 5, noise: 0.03 }), { smooth: 0 });
  const r = cycleAverage(noisy);
  assert(r, 'cycle found');
  assert(Math.abs(r.period - src.duration) < 0.05, `period ${r.period.toFixed(2)} s vs ${src.duration.toFixed(2)} s`);
  assert(r.cycles >= 4, `${r.cycles} cycles`);
  const before = phaseError(src, noisy, 0);
  let after = Infinity;
  for (let k = 0; k < 24; k++) after = Math.min(after, phaseError(src, r.clip, (k / 24) * r.clip.duration));
  assert(after < before * 0.7, `averaging reduces noise (${before.toFixed(1)}° -> ${after.toFixed(1)}°)`);
  const none = cycleAverage(landmarksToClip(fakeTrack(loadMove('reach')), { smooth: 0 }).clip);
  assert(!none, 'a one-off attack is not treated as a cycle');
}

/** Keep head level: a leaning walk keeps the eyes on the horizon, but the head still turns. */
export async function styleKeepHeadLevel() {
  const { applyStyle } = await import('../src/core/style.js');
  const THREE = await import('three');
  const rig = standardRig();
  const src = applyStyle(loadMove('run'), rig, { lean: 20, headTurn: 30 });
  const head = rig.special.head;
  const tilt = (clip) => {
    let worst = 0;
    for (let f = 0; f <= 18; f += 3) {
      const w = evalWorld(clip, f / 30, rig);
      const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(w.wq[head].clone().multiply(rig.restWorld.q[head].clone().invert()));
      worst = Math.max(worst, (upW.angleTo(new THREE.Vector3(0, 1, 0)) * 180) / Math.PI);
    }
    return worst;
  };
  const level = applyStyle(src, rig, { headLevel: 1 });
  assert(tilt(src) > 12, `leaning run tilts the head (${tilt(src).toFixed(0)}°)`);
  assert(tilt(level) < 2, `level head stays upright (${tilt(level).toFixed(1)}°)`);
  const w = evalWorld(level, 0, rig);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(w.wq[head].clone().multiply(rig.restWorld.q[head].clone().invert()));
  assert(Math.abs((Math.atan2(fwd.x, fwd.z) * 180) / Math.PI) > 15, 'the head turn is kept');
}
