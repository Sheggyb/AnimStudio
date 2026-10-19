// Foot contacts: finding plants, measuring and removing foot sliding, footstep events (no downloads needed).
import * as THREE from 'three';
import { assert, tPoseCharacter } from './helpers.js';
import { generateMotion } from '../src/core/gait.js';
import { footReport, plantFeet, footstepEvents, legLength } from '../src/core/contacts.js';
import { cloneClip, makeLayer, getTrack } from '../src/core/clip.js';
import { frameTimes } from '../src/core/channel.js';
import { evalWorld } from '../src/core/evaluate.js';
import { loopError } from '../src/core/analysis.js';
import { bodyOffsetLocal } from '../src/core/anatomy.js';

const rig = tPoseCharacter().rig;
const cm = (x) => `${(x * 100).toFixed(1)} cm`;

/** A walk whose hips surge back and forth at step rate: the planted feet slide on the floor. */
function slidingWalk() {
  const c = generateMotion(rig, 'walk');
  const ch = c.layers[0].tracks[rig.names[rig.special.hips]].pos;
  const amp = 0.05 * legLength(rig);
  for (let k = 0; k < ch.times.length; k++) {
    const off = bodyOffsetLocal(rig, rig.special.hips, [0, 0, amp * Math.sin((ch.times[k] / c.duration) * Math.PI * 4)]).sub(rig.rest[rig.special.hips].p);
    for (let a = 0; a < 3; a++) ch.values[k * 3 + a] += off.getComponent(a);
  }
  return c;
}

export function walkHasAPlantPerFoot() {
  const r = footReport(generateMotion(rig, 'walk'), rig);
  for (const f of r.feet) assert(f.plants >= 1, `${f.side} foot has a plant`);
  assert(r.inPlace, 'a generated walk walks in place');
  assert(r.speed > 0.2 && r.speed < 3, `walking speed ${r.speed.toFixed(2)} m/s`);
  assert(!r.sink && !r.floating, 'feet neither sink nor float');
}

export function plantingRemovesSliding() {
  const c = slidingWalk();
  const before = footReport(c, rig).maxSlide;
  assert(before > 0.015, `the test walk slides (${cm(before)})`);
  const fixed = cloneClip(c, true);
  plantFeet(fixed, { rig, li: 0 });
  const after = footReport(fixed, rig).maxSlide;
  assert(after < 0.005 && after < before * 0.2, `sliding ${cm(before)} -> ${cm(after)}`);
  const err = loopError(fixed, rig);
  assert(err.relative < 0.005, `still loops seamlessly (gap ${(err.relative * 100).toFixed(2)}% of height)`);
}

export function plantingOnALayerKeepsTheBase() {
  const c = slidingWalk();
  c.layers.push(makeLayer('My edits', 'additive'));
  const base = JSON.stringify(Object.keys(c.layers[0].tracks).map((b) => [b, Array.from(c.layers[0].tracks[b].rot?.values || [])]));
  const before = footReport(c, rig).maxSlide;
  plantFeet(c, { rig, li: 1 });
  assert(JSON.stringify(Object.keys(c.layers[0].tracks).map((b) => [b, Array.from(c.layers[0].tracks[b].rot?.values || [])])) === base, 'base layer untouched');
  assert(Object.keys(c.layers[1].tracks).length > 0, 'the corrections are on the layer');
  const after = footReport(c, rig).maxSlide;
  assert(after < before * 0.2, `sliding ${cm(before)} -> ${cm(after)} through the layer`);
}

export function feetDoNotSinkAfterPlanting() {
  const c = generateMotion(rig, 'walk');
  const ch = getTrack(c.layers[0], rig.names[rig.special.hips], 'pos');
  const down = bodyOffsetLocal(rig, rig.special.hips, [0, -0.03, 0]).sub(rig.rest[rig.special.hips].p);
  for (let k = 0; k < ch.times.length; k++) for (let a = 0; a < 3; a++) ch.values[k * 3 + a] += down.getComponent(a);
  assert(footReport(c, rig).sink > 0.02, 'lowered walk sinks into the floor');
  plantFeet(c, { rig, li: 0 });
  assert(footReport(c, rig).sink < 0.002, `no sinking after planting (${cm(footReport(c, rig).sink)})`);
}

export function footstepsOncePerStep() {
  const c = generateMotion(rig, 'walk', { cycles: 2 });
  const n = footstepEvents(c, rig);
  const left = c.events.filter((e) => e.name === 'footstep_L').length;
  const right = c.events.filter((e) => e.name === 'footstep_R').length;
  assert(n === left + right && left === 2 && right === 2, `two steps per foot over two cycles (L ${left}, R ${right})`);
  assert(c.events.every((e, k) => e.t >= 0 && e.t <= c.duration && (!k || e.t >= c.events[k - 1].t)), 'sorted, inside the clip');
  footstepEvents(c, rig);
  assert(c.events.length === n, 'running it again replaces the footsteps');
  const run = generateMotion(rig, 'run');
  assert(footstepEvents(run, rig) === 2, 'a run touches down only briefly but still has a step per foot');
}

export function idleStaysPut() {
  const c = generateMotion(rig, 'idle');
  assert(footstepEvents(cloneClip(c, true), rig) === 0, 'an idle has no footsteps');
  const fixed = cloneClip(c, true);
  plantFeet(fixed, { rig, li: 0 });
  const ankle = rig.byKind.get('foot.L');
  let worst = 0;
  for (const t of frameTimes(0, c.duration, 30)) worst = Math.max(worst, evalWorld(c, t, rig).wp[ankle].distanceTo(evalWorld(fixed, t, rig).wp[ankle]));
  assert(worst < 0.01, `standing feet move ${cm(worst)} at most`);
  assert(new THREE.Vector3().copy(footReport(c, rig).info.treadmill).length() === 0, 'an idle does not walk');
}
