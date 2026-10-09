// Retargeted moves keep their feet on the ground: no floating, no sinking (no downloads needed).
import { assert, tPoseCharacter, mixamoRig } from './helpers.js';
import { evalWorld } from '../src/core/evaluate.js';
import { generateMotion } from '../src/core/gait.js';
import { standardRig } from '../src/core/standard.js';
import { retargetClip } from '../src/core/retarget.js';
import { getTrack } from '../src/core/clip.js';
import { setKey } from '../src/core/channel.js';

const FEET = ['foot.L', 'foot.R', 'toe.L', 'toe.R'];
/** Thigh joints above the ground at rest: the leg length that motion is scaled by. */
const legHeight = (rig) => (rig.restWorld.p[rig.byKind.get('thigh.L')].y + rig.restWorld.p[rig.byKind.get('thigh.R')].y) / 2 - rig.ground;
/** Per frame: the lowest foot's height above its rest height, as a fraction of leg length. */
function footLift(clip, rig) {
  const feet = FEET.map((k) => rig.byKind.get(k)).filter((i) => i >= 0);
  const rest = Math.min(...feet.map((i) => rig.restWorld.p[i].y));
  const out = [];
  for (let f = 0; f <= Math.round(clip.duration * 30); f++) {
    const w = evalWorld(clip, f / 30, rig);
    out.push((Math.min(...feet.map((i) => w.wp[i].y)) - rest) / legHeight(rig));
  }
  return out;
}

/** A generated move whose Root bone also has a (still) position track, as pack moves often do. */
function withRootTrack(clip, rig) {
  const root = rig.names[rig.special.root];
  for (const t of [0, clip.duration]) setKey(getTrack(clip.layers[0], root, 'pos', true), t, rig.rest[rig.special.root].p.toArray());
  return clip;
}

/** The hips' height over a clip (model space). */
function hipsHeights(clip, rig) {
  const out = [];
  for (let f = 0; f <= Math.round(clip.duration * 30); f++) out.push(evalWorld(clip, f / 30, rig).wp[rig.special.hips].y);
  return out;
}

export function feetStayOnTheGround() {
  const std = standardRig(); // has a Root bone above the Hips
  const targets = [
    ['Mixamo-style rig (hips are the root)', mixamoRig()],
    ['character built by AnimStudio', tPoseCharacter().rig],
  ];
  for (const type of ['idle', 'walk', 'run', 'sneak']) {
    const src = withRootTrack(generateMotion(std, type), std);
    const s = footLift(src, std);
    for (const [name, rig] of targets) {
      const { clip } = retargetClip(src, std, rig, { mode: 'auto' });
      const d = footLift(clip, rig);
      const worst = Math.max(...d.map((x, k) => Math.abs(x - s[k])));
      assert(worst < 0.005, `${type} on ${name}: feet ${(worst * 100).toFixed(1)}% of leg length off the source's ground contact`);
    }
  }
}

export function hipsKeepTheirBounceOnMixamoRigs() {
  // A Mixamo rig's hips are its root bone: they must still get the source's up-and-down motion.
  const std = standardRig();
  const src = withRootTrack(generateMotion(std, 'run'), std);
  const rig = mixamoRig();
  const { clip } = retargetClip(src, std, rig, { mode: 'auto' });
  const range = (a) => Math.max(...a) - Math.min(...a);
  const sb = range(hipsHeights(src, std)) / std.height;
  const db = range(hipsHeights(clip, rig)) / rig.height;
  assert(sb > 0.01, `the generated run bounces (${(sb * 100).toFixed(1)}%)`);
  assert(db > sb * 0.5, `hips bounce kept on the Mixamo rig (${(db * 100).toFixed(1)}% vs ${(sb * 100).toFixed(1)}% of height)`);
}
