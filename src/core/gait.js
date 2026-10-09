// Procedural motion generator: brand-new cycles built from scratch on any humanoid skeleton
// (no reference clips). Every value is an anatomical parameter, so an AI or a user can ask for
// "a heavier run with more knee lift" and get it.
import { makeClip, getTrack } from './clip.js';
import { setKey, SMOOTH, frameTimes } from './channel.js';
import { anatomicalLocal, bodyOffsetLocal } from './anatomy.js';
import { evalWorld } from './evaluate.js';

const TAU = Math.PI * 2;

/** Presets. Angles in degrees, distances in fractions of leg length, cycle in seconds. */
export const GAITS = {
  walk: { cycle: 1.05, stride: 24, kneeLift: 38, kneeContact: 6, footRoll: 14, armSwing: 18, elbow: 18, bounce: 0.025, sway: 0.015, hipTwist: 6, lean: 3, chestCounter: 4, headBob: 2, crouch: 0.02, armOut: 6 },
  run: { cycle: 0.68, stride: 42, kneeLift: 95, kneeContact: 18, footRoll: 22, armSwing: 38, elbow: 85, bounce: 0.06, sway: 0.01, hipTwist: 9, lean: 12, chestCounter: 8, headBob: 3, crouch: 0.06, armOut: 10 },
  jog: { cycle: 0.8, stride: 30, kneeLift: 70, kneeContact: 12, footRoll: 18, armSwing: 26, elbow: 70, bounce: 0.04, sway: 0.012, hipTwist: 7, lean: 6, chestCounter: 6, headBob: 2, crouch: 0.04, armOut: 8 },
  sprint: { cycle: 0.55, stride: 55, kneeLift: 115, kneeContact: 22, footRoll: 26, armSwing: 55, elbow: 90, bounce: 0.05, sway: 0.008, hipTwist: 10, lean: 18, chestCounter: 10, headBob: 2, crouch: 0.06, armOut: 8 },
  sneak: { cycle: 1.4, stride: 22, kneeLift: 55, kneeContact: 35, footRoll: 12, armSwing: 8, elbow: 45, bounce: 0.012, sway: 0.02, hipTwist: 5, lean: 20, chestCounter: 3, headBob: 1, crouch: 0.22, armOut: 14 },
  march: { cycle: 1.0, stride: 30, kneeLift: 70, kneeContact: 4, footRoll: 10, armSwing: 32, elbow: 5, bounce: 0.02, sway: 0.008, hipTwist: 3, lean: 0, chestCounter: 2, headBob: 1, crouch: 0.0, armOut: 4 },
  limp: { cycle: 1.3, stride: 20, kneeLift: 30, kneeContact: 10, footRoll: 10, armSwing: 14, elbow: 20, bounce: 0.04, sway: 0.04, hipTwist: 6, lean: 6, chestCounter: 4, headBob: 4, crouch: 0.03, armOut: 8, limp: 0.7 },
  idle: { cycle: 3.2, breathe: 2.5, sway: 0.006, armOut: 6, elbow: 12, headBob: 1.5, lean: 1, idle: true },
};

/**
 * Generate a looping motion on `rig`.
 * @param {string} type key of GAITS
 * @param {object} p overrides of the preset (see GAITS) + { cycles = 1, fps = 30, speed = 1, name }
 */
export function generateMotion(rig, type = 'walk', p = {}) {
  const base = GAITS[type] || GAITS.walk;
  const q = { ...base, ...p };
  const speed = q.speed || 1;
  const cycle = (q.cycle || 1) / speed;
  const cycles = Math.max(1, Math.round(q.cycles || 1));
  const D = cycle * cycles;
  const clip = makeClip(q.name || type[0].toUpperCase() + type.slice(1), D);
  clip.loop = true;
  clip.meta = { source: 'generated', note: `generated ${type}`, generator: { type, params: { ...p } } };
  const L = clip.layers[0];
  const K = (k) => rig.byKind.get(k);
  const hips = rig.special.hips;
  const legLen = hips >= 0 ? rig.restWorld.p[hips].y - rig.ground : rig.height * 0.5;
  const keysPerCycle = q.idle ? 12 : 16;
  const times = [];
  for (let c = 0; c < cycles; c++) for (let k = 0; k < keysPerCycle; k++) times.push(((c + k / keysPerCycle) * cycle));
  times.push(D);

  const put = (i, t, v) => {
    if (i === undefined || i < 0) return;
    setKey(getTrack(L, rig.names[i], 'rot', true), t, anatomicalLocal(rig, i, v).toArray(), SMOOTH);
  };
  const putPos = (i, t, off) => {
    if (i === undefined || i < 0) return;
    setKey(getTrack(L, rig.names[i], 'pos', true), t, bodyOffsetLocal(rig, i, off).toArray(), SMOOTH);
  };
  // armOut is measured from arms hanging down. Rigs bound in a T- or A-pose rest with the arms
  // raised, and anatomical angles are relative to rest, so subtract that rest angle.
  const armDrop = { L: restArmAngle(rig, 'L'), R: restArmAngle(rig, 'R') };
  const spine = [...(rig.chains.spine || []), rig.special.chest].filter((i) => i != null && i >= 0);
  const neck = rig.chains.neck || [];
  const head = rig.special.head ?? K('head');

  for (const t of times) {
    const ph = ((t % cycle) / cycle) * TAU; // 0..2π, left foot contact at 0
    if (q.idle) {
      const b = Math.sin(ph);
      putPos(hips, t, [Math.sin(ph * 0.5) * q.sway * legLen, -Math.abs(b) * 0.004 * legLen, 0]);
      spine.forEach((i, k) => put(i, t, { swing: (q.lean + b * q.breathe * 0.4) / spine.length, spread: Math.sin(ph * 0.5) * 0.8 }));
      if (head !== undefined) put(head, t, { swing: Math.sin(ph + 1) * q.headBob, twist: Math.sin(ph * 0.5) * 2 });
      for (const s of ['L', 'R']) {
        const sg = s === 'L' ? 1 : -1;
        put(K(`clavicle.${s}`), t, { spread: b * q.breathe * 0.5 });
        put(K(`upperarm.${s}`), t, { spread: q.armOut - armDrop[s] + b * 1.5, swing: 3 + sg * 0 });
        put(K(`forearm.${s}`), t, { swing: q.elbow + b * 2 });
        put(K(`thigh.${s}`), t, { spread: 2 });
      }
      continue;
    }
    // ---- body
    const bob = -Math.cos(2 * ph); // two bounces per cycle; lowest at contacts
    const runFlight = q.kneeLift > 80 ? -1 : 1; // runs are highest mid-stride
    const limp = q.limp || 0;
    putPos(hips, t, [Math.sin(ph) * q.sway * legLen, (bob * runFlight * q.bounce - q.crouch) * legLen - (limp ? Math.max(0, Math.sin(ph)) * limp * 0.03 * legLen : 0), 0]);
    if (hips >= 0) put(hips, t, { twist: Math.cos(ph) * q.hipTwist, spread: Math.sin(ph) * 2 });
    spine.forEach((i) => put(i, t, { swing: q.lean / spine.length, twist: (-Math.cos(ph) * (q.hipTwist + q.chestCounter)) / spine.length }));
    neck.forEach((i) => put(i, t, { swing: (-q.lean * 0.4) / Math.max(1, neck.length) }));
    if (head !== undefined) put(head, t, { swing: -q.lean * 0.3 + Math.sin(2 * ph) * q.headBob, twist: Math.cos(ph) * q.chestCounter * 0.5 });

    // ---- legs (L contact at phase 0, R half a cycle later)
    for (const [s, off] of [
      ['L', 0],
      ['R', Math.PI],
    ]) {
      const a = ph + off;
      const swingPhase = Math.sin(a); // >0 = leg travelling forward (swing), <0 = stance
      const hipAng = Math.cos(a) * q.stride; // forward at contact
      const lift = Math.max(0, swingPhase); // knee bends during swing
      const knee = q.kneeContact + lift * (q.kneeLift - q.kneeContact) * (limp && s === 'R' ? 1 - limp * 0.6 : 1);
      put(K(`thigh.${s}`), t, { swing: hipAng + lift * q.kneeLift * 0.25, spread: s === 'L' ? 1 : 1 });
      put(K(`calf.${s}`), t, { swing: -knee });
      // ankle: toes up at contact, push-off at the end of stance, keep sole level otherwise
      const foot = Math.cos(a) > 0.7 ? q.footRoll * (Math.cos(a) - 0.7) * 2 : -Math.max(0, -swingPhase) * q.footRoll * 0.6;
      put(K(`foot.${s}`), t, { swing: foot + knee * 0.35 - hipAng * 0.4 });
      // ---- arms swing opposite to the same-side leg
      put(K(`upperarm.${s}`), t, { swing: -Math.cos(a) * q.armSwing, spread: q.armOut - armDrop[s] });
      put(K(`forearm.${s}`), t, { swing: q.elbow + Math.max(0, -Math.cos(a)) * q.armSwing * 0.4 });
      put(K(`clavicle.${s}`), t, { swing: -Math.cos(a) * q.armSwing * 0.08 });
    }
  }
  groundFeet(clip, rig);
  return clip;
}

/**
 * Raise or lower the whole cycle so the lowest foot touches the ground at its lowest moment.
 * The hip height above is an estimate (crouch, bounce, knee bend on this rig's proportions);
 * without this, a sneak sinks into the floor and a march hovers. Bounce and flight are kept.
 */
function groundFeet(clip, rig) {
  const hips = rig.special.hips;
  const ch = hips >= 0 ? clip.layers[0].tracks[rig.names[hips]]?.pos : null;
  const feet = ['foot.L', 'foot.R', 'toe.L', 'toe.R'].map((k) => rig.byKind.get(k)).filter((i) => i >= 0);
  if (!ch || !feet.length) return;
  const rest = Math.min(...feet.map((i) => rig.restWorld.p[i].y));
  let low = Infinity;
  const w = { lq: [], lp: [], wq: [], wp: [] };
  for (let f = 0; f <= Math.round(clip.duration * 30); f++) {
    evalWorld(clip, Math.min(f / 30, clip.duration), rig, w);
    low = Math.min(low, ...feet.map((i) => w.wp[i].y));
  }
  const d = bodyOffsetLocal(rig, hips, [0, rest - low, 0]).sub(rig.rest[hips].p); // straight up, in the hips' parent space
  for (let k = 0; k < ch.times.length; k++) for (let c = 0; c < 3; c++) ch.values[k * 3 + c] += d.getComponent(c);
}

/**
 * How far the upper arm is raised sideways at rest, in degrees (0 = hanging straight down,
 * ~90 = T-pose). Measured in the body's frontal plane from the shoulder to the elbow.
 */
export function restArmAngle(rig, side) {
  const up = rig.byKind.get(`upperarm.${side}`);
  const fore = rig.byKind.get(`forearm.${side}`);
  if (up === undefined || fore === undefined) return 0;
  const d = rig.restWorld.p[fore].clone().sub(rig.restWorld.p[up]);
  const deg = (Math.atan2(Math.abs(d[rig.lateral]), -d.y) * 180) / Math.PI;
  return deg > 15 ? deg : 0; // arms already down: leave as authored
}

/** Names of available motion types. */
export const MOTION_TYPES = Object.keys(GAITS);
export { frameTimes };
