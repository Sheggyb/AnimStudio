// Sequences: clips played one after another with crossfades, as a game blends them (no downloads needed).
import { assert, tPoseCharacter } from './helpers.js';
import { generateMotion } from '../src/core/gait.js';
import { sequenceClips } from '../src/core/ops.js';
import { footstepEvents } from '../src/core/contacts.js';
import { frameTimes } from '../src/core/channel.js';
import { evalWorld } from '../src/core/evaluate.js';
import { bodyOffsetLocal } from '../src/core/anatomy.js';

const rig = tPoseCharacter().rig;
const ctx = { rig };

export function sequenceLengthAndSmoothJoins() {
  const idle = generateMotion(rig, 'idle');
  const walk = generateMotion(rig, 'walk');
  const run = generateMotion(rig, 'run');
  const seq = sequenceClips([{ clip: idle, blend: 6 }, { clip: walk, repeat: 2, blend: 6 }, { clip: run }], ctx);
  const want = idle.duration + 2 * walk.duration + run.duration - 2 * (6 / 30);
  assert(Math.abs(seq.duration - want) < 1e-6, `length ${seq.duration.toFixed(3)} s, want ${want.toFixed(3)} s`);
  // No pose jumps: frame to frame, no joint moves further than it does inside the clips themselves.
  const step = (c) => {
    let worst = 0;
    let prev = null;
    for (const t of frameTimes(0, c.duration, 30)) {
      const w = evalWorld(c, t, rig).wp.map((p) => p.clone());
      if (prev) worst = Math.max(worst, ...w.map((p, i) => p.distanceTo(prev[i])));
      prev = w;
    }
    return worst;
  };
  const inside = Math.max(step(idle), step(walk), step(run));
  const seqStep = step(seq);
  assert(seqStep < inside * 1.25 + 0.01, `smooth joins (biggest move per frame ${seqStep.toFixed(3)} m, ${inside.toFixed(3)} m inside the clips)`);
}

export function travelCarriesOn() {
  // A walk that travels 1 m per cycle, three times: 3 m in all, no jumping back at the seams.
  const walk = generateMotion(rig, 'walk', { plant: false });
  const h = rig.special.hips;
  const pos = walk.layers[0].tracks[rig.names[h]].pos;
  for (let k = 0; k < pos.times.length; k++) {
    const off = bodyOffsetLocal(rig, h, [0, 0, pos.times[k] / walk.duration]).sub(rig.rest[h].p);
    for (let a = 0; a < 3; a++) pos.values[k * 3 + a] += off.getComponent(a);
  }
  const seq = sequenceClips([{ clip: walk, repeat: 3 }], ctx);
  const f = rig.forwardAxis;
  const z = frameTimes(0, seq.duration, 30).map((t) => evalWorld(seq, t, rig).wp[h][f] * rig.forwardSign);
  const total = z[z.length - 1] - z[0];
  assert(Math.abs(total - 3) < 0.05, `travels ${total.toFixed(2)} m in three cycles`);
  const back = Math.min(...z.slice(1).map((v, k) => v - z[k]));
  assert(back > -0.02, `never jumps back (${back.toFixed(3)} m)`);
}

export function eventsRepeatWithTheirClips() {
  const walk = generateMotion(rig, 'walk');
  const n = footstepEvents(walk, rig);
  const seq = sequenceClips([{ clip: walk, repeat: 3 }], ctx);
  assert(seq.events.length === 3 * n, `${seq.events.length} events for 3 × ${n}`);
  assert(seq.events.every((e) => e.t >= 0 && e.t <= seq.duration + 1e-6), 'events inside the sequence');
}
