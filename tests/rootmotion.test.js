// Root motion: travel moves from the hips onto the root bone, the body stays where it was (no downloads needed).
import * as THREE from 'three';
import { assert, tPoseCharacter, mixamoRig } from './helpers.js';
import { generateMotion } from '../src/core/gait.js';
import { extractRootMotion, rootBone } from '../src/core/rootmotion.js';
import { cloneClip, getTrack } from '../src/core/clip.js';
import { frameTimes } from '../src/core/channel.js';
import { evalWorld } from '../src/core/evaluate.js';
import { bodyOffsetLocal } from '../src/core/anatomy.js';
import * as ops from '../src/core/ops.js';

const rig = tPoseCharacter().rig;

/** A generated walk that travels `dist` metres forward (and turns `turnDeg` degrees) over the clip. */
function travellingWalk(dist = 1.2, turnDeg = 0) {
  const c = generateMotion(rig, 'walk', { plant: false });
  const h = rig.special.hips;
  const pos = c.layers[0].tracks[rig.names[h]].pos;
  for (let k = 0; k < pos.times.length; k++) {
    const u = pos.times[k] / c.duration;
    const off = bodyOffsetLocal(rig, h, [0, 0, dist * u]).sub(rig.rest[h].p);
    for (let a = 0; a < 3; a++) pos.values[k * 3 + a] += off.getComponent(a);
  }
  if (turnDeg) {
    const rot = getTrack(c.layers[0], rig.names[h], 'rot', true);
    const q = new THREE.Quaternion();
    for (let k = 0; k < rot.times.length; k++) {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((turnDeg * Math.PI) / 180) * (rot.times[k] / c.duration));
      new THREE.Quaternion().fromArray(rot.values, k * 4).premultiply(q).toArray(rot.values, k * 4);
    }
  }
  c.loop = false;
  return c;
}

const worst = (a, b, fn) => Math.max(...frameTimes(0, a.duration, 30).map((t) => fn(evalWorld(a, t, rig), evalWorld(b, t, rig))));

export function travelGoesOnTheRoot() {
  const c = travellingWalk();
  const out = cloneClip(c, true);
  const msg = extractRootMotion(out, { rig });
  const r = rootBone(rig),
    h = rig.special.hips;
  assert(r >= 0 && out.layers[0].tracks[rig.names[r]]?.pos, `the root has a position track (${msg})`);
  // Every joint but the root stays where it was.
  const moved = worst(c, out, (a, b) => Math.max(...a.wp.map((p, i) => (i === rootBone(rig) ? 0 : p.distanceTo(b.wp[i])))));
  assert(moved < 1e-4, `the body didn't move (${moved.toExponential(1)} m)`);
  // The root travels along the floor; the hips stay above it.
  const end = evalWorld(out, out.duration, rig);
  const start = evalWorld(out, 0, rig);
  const travel = end.wp[r].clone().sub(start.wp[r]);
  assert(Math.abs(travel.length() - 1.2) < 0.05, `root travels ${travel.length().toFixed(3)} m`);
  assert(Math.abs(end.wp[r].y - rig.restWorld.p[r].y) < 1e-4, 'the root stays on the floor');
  const apart = worst(out, out, (a) => Math.hypot(a.wp[h].x - a.wp[r].x - (rig.restWorld.p[h].x - rig.restWorld.p[r].x), a.wp[h].z - a.wp[r].z - (rig.restWorld.p[h].z - rig.restWorld.p[r].z)));
  assert(apart < 0.08, `the hips stay over the root (${apart.toFixed(3)} m apart at most)`);
  assert(/travels 1\.\d+ m/.test(msg), msg);
}

export function cyclesTravelAtASteadySpeed() {
  const c = travellingWalk();
  c.loop = true;
  extractRootMotion(c, { rig });
  const r = rootBone(rig);
  const ts = frameTimes(0, c.duration, 30);
  const z = ts.map((t) => evalWorld(c, t, rig).wp[r][rig.forwardAxis]);
  const steps = z.slice(1).map((v, k) => v - z[k]);
  const spread = Math.max(...steps) - Math.min(...steps);
  assert(spread < 1e-3, `same distance every frame (spread ${spread.toExponential(1)})`);
}

export function turningMovesTurnTheRoot() {
  const c = travellingWalk(1, 90);
  const out = cloneClip(c, true);
  extractRootMotion(out, { rig }, { turn: true });
  const r = rootBone(rig);
  const moved = worst(c, out, (a, b) => Math.max(...a.wp.map((p, i) => (i === rootBone(rig) ? 0 : p.distanceTo(b.wp[i])))));
  assert(moved < 1e-4, `the body didn't move (${moved.toExponential(1)} m)`);
  const q0 = evalWorld(out, 0, rig).wq[r],
    q1 = evalWorld(out, out.duration, rig).wq[r];
  const deg = (q0.angleTo(q1) * 180) / Math.PI;
  assert(deg > 60 && deg < 100, `the root turned with the body (${deg.toFixed(0)}°)`);
}

export function rigsWithoutARootSayHow() {
  const mx = mixamoRig();
  assert(rootBone(mx) < 0, 'Mixamo hips are the root bone');
  const msg = extractRootMotion(generateMotion(mx, 'walk'), { rig: mx });
  assert(/no root bone/.test(msg), msg);
  const viaOp = ops.rootMotion(generateMotion(mx, 'walk'), { rig: mx }, { mode: 'root' });
  assert(/no root bone/.test(viaOp), viaOp);
}
