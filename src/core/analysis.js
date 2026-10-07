// Animation analysis — the "learn from existing clips" tools.
import * as THREE from 'three';
import { frameTimes } from './channel.js';
import { evalWorld, evalBone, makeXform } from './evaluate.js';

const DEG = 180 / Math.PI;

/**
 * Per-frame motion of the main body joints.
 * speed[k]  – summed joint speed (model units / s) at frame k
 * groupTravel / boneTravel – distance travelled over the whole clip
 */
export function motionProfile(clip, rig, { fps = 30 } = {}) {
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  const idx = [...rig.core];
  const speed = new Float32Array(times.length);
  const boneTravel = new Float32Array(rig.bones.length);
  const groupTravel = {};
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  let prev = null;
  times.forEach((t, k) => {
    evalWorld(clip, t, rig, ws);
    const cur = idx.map((i) => ws.wp[i].clone());
    if (prev) {
      const dt = t - times[k - 1] || 1 / fps;
      let sum = 0;
      idx.forEach((i, j) => {
        const d = cur[j].distanceTo(prev[j]);
        sum += d;
        boneTravel[i] += d;
        const g = rig.group[i];
        groupTravel[g] = (groupTravel[g] || 0) + d;
      });
      speed[k] = sum / dt;
    }
    prev = cur;
  });
  if (speed.length > 1) speed[0] = speed[1];
  return { times, speed, boneTravel, groupTravel };
}

/**
 * Key poses = moments where the body is (relatively) still: extremes, contacts, holds.
 * Returns sorted times including the first and last frame.
 */
export function keyPoseTimes(profile, { minGap = 0.2, maxPoses = 24 } = {}) {
  const { times, speed } = profile;
  const n = times.length;
  if (n < 3) return [...times];
  const s = Array.from(speed, (_, k) => (speed[Math.max(0, k - 1)] + 2 * speed[k] + speed[Math.min(n - 1, k + 1)]) / 4);
  const cands = [];
  for (let k = 1; k < n - 1; k++) if (s[k] <= s[k - 1] && s[k] < s[k + 1]) cands.push(k);
  cands.sort((a, b) => s[a] - s[b]);
  const chosen = [0, n - 1];
  for (const k of cands) {
    if (chosen.length >= maxPoses) break;
    if (chosen.every((c) => Math.abs(times[c] - times[k]) >= minGap)) chosen.push(k);
  }
  return chosen.sort((a, b) => a - b).map((k) => times[k]);
}

/** How well the clip loops: worst joint gap between first and last frame. */
export function loopError(clip, rig) {
  if (clip.duration <= 0) return { distance: 0, angle: 0, relative: 0 };
  const a = evalWorld(clip, 0, rig);
  const pa = a.wp.map((v) => v.clone());
  const qa = a.lq.map((q) => q.clone());
  const b = evalWorld(clip, clip.duration, rig);
  let distance = 0,
    angle = 0;
  for (const i of rig.core) {
    distance = Math.max(distance, pa[i].distanceTo(b.wp[i]));
    angle = Math.max(angle, qa[i].angleTo(b.lq[i]) * DEG);
  }
  return { distance, angle, relative: distance / rig.height };
}

/** Euler range (degrees) a bone goes through in this clip. */
export function rangeOfMotion(clip, rig, boneIndex, { fps = 30 } = {}) {
  const x = makeXform();
  const e = new THREE.Euler();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const times = clip.duration > 0 ? frameTimes(0, clip.duration, fps) : [0];
  for (const t of times) {
    evalBone(clip, rig.names[boneIndex], t, rig.rest[boneIndex], x);
    e.setFromQuaternion(x.q, 'XYZ');
    [e.x, e.y, e.z].forEach((v, k) => {
      min[k] = Math.min(min[k], v * DEG);
      max[k] = Math.max(max[k], v * DEG);
    });
  }
  return { min, max };
}

/** World-space path of a joint across the clip (for motion trails). */
export function jointPath(clip, rig, boneIndex, { fps = 30, t0 = 0, t1 = clip.duration } = {}) {
  const times = t1 > t0 ? frameTimes(t0, t1, fps) : [t0];
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  return times.map((t) => {
    evalWorld(clip, t, rig, ws);
    return { t, p: ws.wp[boneIndex].clone() };
  });
}
