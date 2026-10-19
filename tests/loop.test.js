// Find best loop: a long take (as from motion capture) becomes a seamless loop (no downloads needed).
import { assert, tPoseCharacter } from './helpers.js';
import { generateMotion } from '../src/core/gait.js';
import { findLoop, makeLoop, trim } from '../src/core/ops.js';
import { loopError } from '../src/core/analysis.js';
import { cloneClip } from '../src/core/clip.js';
import { evalWorld } from '../src/core/evaluate.js';
import { bodyOffsetLocal } from '../src/core/anatomy.js';

const rig = tPoseCharacter().rig;
const ctx = { rig };

/** Four walk cycles cut at odd places, walking forward 1 m per cycle: a raw mocap take. */
function take() {
  const c = generateMotion(rig, 'walk', { cycles: 4 });
  const h = rig.special.hips;
  const pos = c.layers[0].tracks[rig.names[h]].pos;
  const cycle = c.duration / 4;
  for (let k = 0; k < pos.times.length; k++) {
    const off = bodyOffsetLocal(rig, h, [0, 0, pos.times[k] / cycle]).sub(rig.rest[h].p);
    for (let a = 0; a < 3; a++) pos.values[k * 3 + a] += off.getComponent(a);
  }
  trim(c, 0.37 * cycle, 3.81 * cycle);
  c.loop = false;
  return { c, cycle };
}

export function bestLoopIsAWholeNumberOfSteps() {
  const { c, cycle } = take();
  const r = findLoop(c, ctx, { min: 0.6, max: 4 });
  assert(r, 'found a loop');
  const steps = (r.to - r.from) / (cycle / 2); // a step = half a cycle
  assert(Math.abs(steps - Math.round(steps)) < 0.15 && Math.round(steps) >= 2, `a whole number of steps (${steps.toFixed(2)})`);
  assert(r.error < 3, `seam ${r.error.toFixed(2)}°`);
}

export function madeLoopIsSeamlessAndInPlace() {
  const { c } = take();
  const out = cloneClip(c, true);
  const msg = makeLoop(out, ctx, { min: 0.6, max: 4 });
  assert(out.loop && /^Loop: frames/.test(msg), msg);
  const err = loopError(out, rig);
  assert(err.relative < 0.01 && err.angle < 3, `seamless (${(err.relative * 100).toFixed(2)}% of height, ${err.angle.toFixed(1)}°)`);
  const h = rig.special.hips;
  const travel = evalWorld(out, out.duration, rig).wp[h].distanceTo(evalWorld(out, 0, rig).wp[h]);
  assert(travel < 0.02, `in place (${travel.toFixed(3)} m between the ends)`);
  assert(/shorter/.test(makeLoop(generateMotion(rig, 'walk'), ctx, { min: 5 })), 'too short to search says so');
}
