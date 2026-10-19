// Foot contacts: when each foot is planted, how far it slides while it is, how fast the move
// travels, and pinning planted feet in place.
//
// Sliding feet are the most visible flaw of a move put on another body: the stride no longer
// matches the leg length, so a planted foot skates. In-place cycles (most game walks and runs)
// are measured on a treadmill: the ground under the character moves back at walking speed and a
// planted foot moves with it, so contacts are found in the ground's own frame. That treadmill
// speed is also the speed a game should move the character at.
//
// A foot rolls while it is down (heel strike, flat, push off the ball), so a plant pins one point
// at a time: the heel, then the ball once the heel lifts. The ball's spot follows from where the
// heel stood, so the pinned point never jumps.
import * as THREE from 'three';
import { frameTimes } from './channel.js';
import { cloneClip } from './clip.js';
import { evalWorld, applyPose } from './evaluate.js';
import { makeScratchSkeleton } from './rig.js';
import { solveTwoBone } from './ik.js';
import { keyBone } from './keying.js';

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The parts of each foot that touch the ground: the ankle (heel) and the ball (toe bone). */
export function footJoints(rig) {
  const out = [];
  for (const side of ['L', 'R']) {
    const ik = rig.ik[`foot.${side}`];
    if (!ik || ik.end == null || ik.end < 0) continue;
    const joints = [ik.end, ik.toe].filter((i) => i != null && i >= 0);
    out.push({ side, ik, joints, rest: joints.map((i) => rig.restWorld.p[i].y - rig.ground) });
  }
  return out;
}

/**
 * Default thresholds as fractions of the leg length: a planted foot is at most `height` above
 * where it rests on the floor, rises or drops slower than `rise` per second and, against the
 * ground, moves slower than `speed` per second or than `relSpeed` of the move's own speed. A
 * swing foot skimming the floor moves about twice as fast as the ground, so a sliding foot still
 * counts as down (that's the one to fix), but a foot pushing off or touching down doesn't. Leg
 * length, not body height, so big-headed characters, whose feet barely lift, are judged by
 * their legs.
 */
export const CONTACT_DEFAULTS = { height: 0.04, rise: 0.3, relRise: 0.15, speed: 0.6, relSpeed: 1, minFrames: 2, gap: 2, roll: 0.012 };

/** Height of the hip joints above the floor at rest (half the body height when there are no legs). */
export function legLength(rig) {
  const t = ['thigh.L', 'thigh.R'].map((k) => rig.byKind.get(k)).filter((i) => i >= 0);
  const l = t.length ? t.reduce((s, i) => s + rig.restWorld.p[i].y, 0) / t.length - rig.ground : 0;
  return l > 1e-4 ? l : rig.height * 0.5;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Frames (indices) where flags[k] is true, as [start, end] runs; tiny gaps closed, short runs dropped. */
function runsOf(flags, { minFrames, gap, cyclic }) {
  const n = flags.length;
  const f = Uint8Array.from(flags);
  for (let k = 0; k < n; k++) {
    if (f[k]) continue;
    let j = k;
    while (j < n && !flags[j]) j++;
    if (k > 0 && j < n && j - k <= gap) for (let x = k; x < j; x++) f[x] = 1;
    k = j;
  }
  let runs = [];
  for (let k = 0; k < n; k++) {
    if (!f[k]) continue;
    let j = k;
    while (j + 1 < n && f[j + 1]) j++;
    runs.push([k, j]);
    k = j;
  }
  // A loop's last frame is its first: a contact across the seam is one contact.
  if (cyclic && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n - 1) {
    const last = runs.pop();
    runs[0] = [last[0], runs[0][1]]; // start > end: wraps around
  }
  const len = ([a, b]) => (b >= a ? b - a + 1 : n - a + b);
  return runs.filter((r) => len(r) >= minFrames || (r[0] === 0 && r[1] === n - 1));
}

/** Frame indices of a run in order (handles runs that wrap around a loop's seam). */
const runFrames = ([a, b], n) => {
  const out = [];
  if (b >= a) for (let k = a; k <= b; k++) out.push(k);
  else {
    for (let k = a; k < n; k++) out.push(k);
    for (let k = 0; k <= b; k++) out.push(k); // frame 0 is the same moment as frame n-1
  }
  return out;
};

/** A frame's time, continued past the loop's end for the part of a wrapped run after the seam. */
function unwrapTime(times, k, [a, b]) {
  const D = times[times.length - 1];
  return b < a && k <= b && k < a ? times[k] + D : times[k];
}

/** Position in the frame of a ground that moves with velocity `v` (in place -> world). */
const groundPos = (p, t, v) => new THREE.Vector3(p.x - v.x * t, p.y, p.z - v.z * t);

/**
 * Sample the feet and find their plants.
 * Returns { times, fps, n, cyclic, legLength, treadmill (horizontal velocity of the ground under an
 *   in-place move), travel (the hips' average horizontal velocity),
 *   feet: [{ side, ik, joints, rest, pos: [[Vector3 per joint] per frame],
 *            plants: [{ start, end, frames, parts: [{ joint, frames, anchor (ground frame) }] }] }] }
 */
export function findContacts(clip, rig, opts = {}) {
  const o = { ...CONTACT_DEFAULTS, ...opts };
  const fps = opts.fps || 30;
  const L = legLength(rig);
  const feet = footJoints(rig);
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const n = times.length;
  const cyclic = !!clip.loop && n > 2;
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  const hips = rig.special.hips;
  const hipsPos = [];
  for (const f of feet) f.pos = [];
  for (let k = 0; k < n; k++) {
    evalWorld(clip, times[k], rig, ws);
    for (const f of feet) f.pos.push(f.joints.map((i) => ws.wp[i].clone()));
    if (hips >= 0) hipsPos.push(ws.wp[hips].clone());
  }
  const lift = (f, k, j) => f.pos[k][j].y - rig.ground - f.rest[j]; // height above where it rests on the floor
  const lowest = (f, k) => {
    let best = 0;
    for (let j = 1; j < f.joints.length; j++) if (lift(f, k, j) < lift(f, k, best)) best = j;
    return best;
  };
  // Velocity of a joint at frame k (central difference; loops wrap).
  const vel = (f, j, k) => {
    let a = k - 1,
      b = k + 1;
    if (a < 0) a = cyclic ? n - 2 : 0;
    if (b > n - 1) b = cyclic ? 1 : n - 1;
    if (a === b) return new THREE.Vector3();
    const span = cyclic && (k === 0 || k === n - 1) ? 2 / fps : times[b] - times[a] || 1 / fps;
    return f.pos[b][j].clone().sub(f.pos[a][j]).divideScalar(span);
  };

  // The treadmill: how fast the ground slides back under the foot that stands on it (zero for
  // moves that travel). Each frame only the lowest point of both feet counts: a swing foot that
  // skims the floor moves the other way.
  const vx = [],
    vz = [];
  for (let k = 0; k < n; k++) {
    let best = null;
    for (const f of feet) {
      const j = lowest(f, k);
      if (!best || lift(f, k, j) < lift(best.f, k, best.j)) best = { f, j };
    }
    if (!best || lift(best.f, k, best.j) > o.height * L) continue;
    const v = vel(best.f, best.j, k);
    vx.push(v.x);
    vz.push(v.z);
  }
  const treadmill = new THREE.Vector3(median(vx), 0, median(vz));
  if (treadmill.length() < 0.02 * L) treadmill.set(0, 0, 0); // standing still
  // Faster moves land harder and stand shorter: the tolerances grow with their speed.
  const vTol = Math.max(o.speed * L, o.relSpeed * treadmill.length());
  const yTol = Math.max(o.rise * L, o.relRise * treadmill.length());

  for (const f of feet) {
    // Down: its lowest point is on the floor, neither rising nor dropping, and (in the ground's
    // frame) still.
    const down = [];
    for (let k = 0; k < n; k++) {
      const j = lowest(f, k);
      const v = vel(f, j, k);
      down.push(lift(f, k, j) < o.height * L && Math.abs(v.y) < yTol && v.setY(0).sub(treadmill).length() < vTol);
    }
    f.plants = runsOf(down, { minFrames: o.minFrames, gap: o.gap, cyclic }).map((r) => {
      const frames = runFrames(r, n);
      // The pinned point rolls heel -> ball (or ball -> heel on a toe-first landing) when the
      // other one gets clearly lower; short flickers don't count.
      const pin = [];
      let cur = lowest(f, frames[0]);
      for (const k of frames) {
        const j = lowest(f, k);
        if (j !== cur && lift(f, k, j) < lift(f, k, cur) - o.roll * L) cur = j;
        pin.push(cur);
      }
      const parts = [];
      frames.forEach((k, idx) => {
        const last = parts[parts.length - 1];
        if (last && last.joint === pin[idx]) last.frames.push(k);
        else parts.push({ joint: pin[idx], frames: [k] });
      });
      // The first point stands on the average of where it was; each next one where it is when
      // the foot rolls onto it, measured from the point before (so the pin never jumps).
      parts.forEach((part, pi) => {
        if (pi === 0) {
          part.anchor = new THREE.Vector3();
          for (const k of part.frames) part.anchor.add(groundPos(f.pos[k][part.joint], unwrapTime(times, k, r), treadmill));
          part.anchor.divideScalar(part.frames.length);
        } else {
          const prev = parts[pi - 1];
          const k = part.frames[0];
          const off = f.pos[k][part.joint].clone().sub(f.pos[k][prev.joint]);
          part.anchor = prev.anchor.clone().add(off.setY(0));
          part.anchor.y = 0;
        }
      });
      return { start: r[0], end: r[1], frames, parts, run: r };
    });
  }
  const travel = new THREE.Vector3();
  if (hipsPos.length > 1 && clip.duration > 0) travel.copy(hipsPos[n - 1]).sub(hipsPos[0]).setY(0).divideScalar(clip.duration);
  return { times, fps, n, cyclic, legLength: L, feet, treadmill, travel };
}

/** Where a planted part should be at frame k (model space, horizontal). */
function spotAt(info, plant, part, k) {
  const t = unwrapTime(info.times, k, plant.run);
  return new THREE.Vector3(part.anchor.x + info.treadmill.x * t, 0, part.anchor.z + info.treadmill.z * t);
}

/**
 * The feet of a clip at a glance: plants, sliding, sinking, floating and the speed to move the
 * character at in a game. Distances in model units (metres), speeds per second.
 */
export function footReport(clip, rig, opts = {}) {
  const info = findContacts(clip, rig, opts);
  const L = info.legLength;
  let sink = 0,
    low = Infinity;
  const steps = [];
  const feet = info.feet.map((f) => {
    let maxSlide = 0;
    for (const p of f.plants) {
      // How far each pinned point wanders while it carries weight: the frames it is firmly on
      // the floor, in the ground's frame. Touching down and pushing off (the first and last three
      // moments of a longer step; a loop's seam is one moment) are transitions, not sliding.
      let slide = 0;
      const moments = p.frames.filter((k) => !(info.cyclic && k === 0 && p.frames.includes(info.n - 1)));
      const edge = moments.length > 8 ? new Set([...moments.slice(0, 3), ...moments.slice(-3), ...(moments.slice(-3).includes(info.n - 1) || moments.slice(0, 3).includes(info.n - 1) ? [0] : [])]) : new Set();
      for (const part of p.parts) {
        const firm = part.frames.filter((k) => !edge.has(k) && f.pos[k][part.joint].y - rig.ground - f.rest[part.joint] < 0.5 * (opts.height ?? CONTACT_DEFAULTS.height) * L);
        if (!firm.length) continue;
        const pts = firm.map((k) => groundPos(f.pos[k][part.joint], unwrapTime(info.times, k, p.run), info.treadmill));
        const mid = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(pts.length);
        for (const q of pts) slide = Math.max(slide, 2 * Math.hypot(q.x - mid.x, q.z - mid.z));
      }
      p.slide = slide;
      maxSlide = Math.max(maxSlide, slide);
      steps.push({ side: f.side, start: p.start, end: p.end, from: info.times[p.start], to: info.times[p.end], slide });
    }
    for (let k = 0; k < info.n; k++)
      f.joints.forEach((_, j) => {
        const l = f.pos[k][j].y - rig.ground - f.rest[j];
        sink = Math.max(sink, -l);
        low = Math.min(low, l);
      });
    return { side: f.side, plants: f.plants.length, maxSlide };
  });
  steps.sort((a, b) => a.from - b.from);
  const speedVec = info.treadmill.lengthSq() > 0 ? info.treadmill.clone().negate() : info.travel;
  return {
    feet,
    steps,
    maxSlide: Math.max(0, ...feet.map((f) => f.maxSlide)),
    sink: sink > 0.004 * L ? sink : 0,
    // Never on the ground (lowest point above where it rests): floating, or a jump or fall.
    floating: !steps.length && low > (opts.height ?? CONTACT_DEFAULTS.height) * L ? low : 0,
    inPlace: info.treadmill.lengthSq() > 0,
    speed: speedVec.length(),
    heading: speedVec.lengthSq() > 0 ? speedVec.clone().normalize() : null,
    legLength: L,
    info,
  };
}

/**
 * Pin planted feet: while a foot is down its pinned point (heel, then ball) stays where it stands
 * (moving with the treadmill for in-place cycles), easing in and out over `blend` frames around
 * each plant, solved with leg IK and keyed on layer ctx.li. With `ground`, feet never dip below
 * the floor either. Returns a message.
 */
export function plantFeet(clip, ctx, { sides = ['L', 'R'], blend = 3, ground = true, fps = 30, ...detect } = {}) {
  const rig = ctx.rig;
  const li = ctx.li ?? 0;
  const info = findContacts(clip, rig, { fps, ...detect });
  const { n } = info;
  const feet = info.feet.filter((f) => sides.includes(f.side));
  if (!feet.length) return 'No legs found on this rig';
  const ramp = Math.max(1, blend);

  // Per foot, per frame: where the ankle should be (model space).
  const plans = feet.map((f) => {
    const target = f.pos.map((p) => p[0].clone());
    // While down: move the ankle sideways so the pinned point stays on its spot. The foot keeps
    // its orientation (heel-toe roll survives). Heights stay as they are: only sliding goes.
    const corr = new Array(n).fill(null);
    for (const p of f.plants)
      for (const part of p.parts)
        for (const k of part.frames) {
          const s = spotAt(info, p, part, k);
          const j = f.pos[k][part.joint];
          corr[k] = new THREE.Vector3(s.x - j.x, 0, s.z - j.z);
        }
    // Ease in before each plant and out after it (around the seam of a loop).
    const eased = corr.map((c) => c && c.clone());
    for (let k = 0; k < n; k++) {
      if (corr[k]) continue;
      const near = (dir) => {
        for (let d = 1; d <= ramp; d++) {
          let j = k + dir * d;
          if (info.cyclic) j = ((j % (n - 1)) + (n - 1)) % (n - 1);
          if (j < 0 || j >= n) return null;
          if (corr[j]) return { c: corr[j], w: smoothstep(1 - d / (ramp + 1)) };
        }
        return null;
      };
      const a = near(-1),
        b = near(1);
      if (!a && !b) continue;
      const v = new THREE.Vector3();
      if (a) v.addScaledVector(a.c, a.w);
      if (b) v.addScaledVector(b.c, b.w);
      eased[k] = v.divideScalar(Math.max(1, (a?.w || 0) + (b?.w || 0)));
    }
    for (let k = 0; k < n; k++) {
      if (eased[k]) target[k].add(eased[k]);
      if (ground) {
        // Nothing below the floor: lift the whole foot by its lowest part's dip.
        let dip = 0;
        f.joints.forEach((_, j) => (dip = Math.max(dip, rig.ground + f.rest[j] - f.pos[k][j].y)));
        if (dip > 1e-5) target[k].y += dip;
      }
    }
    // Frames to key: the corrected ones, and the ones just outside them with the pose unchanged
    // (so an additive layer doesn't carry the correction into the step in between).
    const changed = target.map((p, k) => p.distanceTo(f.pos[k][0]) > 5e-4 * rig.height); // ~1 mm
    const keep = changed.map((c, k) => !c && (changed[k - 1] || changed[k + 1]));
    return { f, target, changed, keep };
  });

  // The legs are solved on a copy of the clip as it was, so keys written along the way don't
  // change the poses that later frames start from.
  const orig = cloneClip(clip);
  const sk = makeScratchSkeleton(rig);
  const q = new THREE.Quaternion();
  let moved = 0;
  for (let k = 0; k < n; k++) {
    const todo = plans.filter((p) => p.changed[k] || p.keep[k]);
    if (!todo.length) continue;
    const t = info.times[k];
    applyPose(orig, t, rig, sk.bones);
    sk.root.updateMatrixWorld(true);
    for (const { f, target, changed } of todo) {
      const { ik } = f;
      if (changed[k]) {
        // The foot keeps its world orientation (keepEndRotation), so heel-toe roll survives.
        solveTwoBone(sk.bones[ik.upper], sk.bones[ik.lower], sk.bones[ik.end], target[k], { keepEndRotation: true });
        moved++;
      }
      for (const b of [ik.upper, ik.lower, ik.end]) {
        const bone = sk.bones[b];
        keyBone(clip, li, rig.names[b], t, { p: bone.position, q: q.copy(bone.quaternion), s: bone.scale }, rig.rest[b], { rot: true, pos: false, scl: false });
      }
    }
  }
  const plants = feet.reduce((s, f) => s + f.plants.length, 0);
  if (!plants && !moved) return 'No foot contacts found (the feet never stand still on the ground)';
  return `Feet planted: ${plants} step${plants === 1 ? '' : 's'}, ${moved} leg pose${moved === 1 ? '' : 's'} adjusted`;
}

/**
 * Footstep events where each foot lands ("footstep_L", "footstep_R", or one `name` for both).
 * Replaces footstep events made before. A foot that is down from the very first frame of a
 * one-shot clip has not landed, so it gets no event. Returns the number of events.
 */
export function footstepEvents(clip, rig, { fps = 30, name = null, ...detect } = {}) {
  const info = findContacts(clip, rig, { fps, ...detect });
  // A foot that only touches down for an instant (fast runs) has no plant: count its touches.
  let brief = null;
  const plantsOf = (f, i) => (f.plants.length ? f.plants : (brief ||= findContacts(clip, rig, { fps, ...detect, minFrames: 1, rise: 2, relRise: 1 })).feet[i].plants);
  const names = new Set(['footstep_L', 'footstep_R', name || 'footstep']);
  clip.events = clip.events.filter((e) => !names.has(e.name));
  let made = 0;
  for (const [i, f] of info.feet.entries())
    for (const p of plantsOf(f, i)) {
      if (!info.cyclic && p.start === 0) continue; // already standing at the start
      if (info.cyclic && p.frames.length >= info.n) continue; // never lifts
      clip.events.push({ t: info.times[p.start], name: name || `footstep_${f.side}` });
      made++;
    }
  clip.events.sort((a, b) => a.t - b.t);
  return made;
}
