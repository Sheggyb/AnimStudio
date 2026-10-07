import { assert, tPoseCharacter } from './helpers.js';
import { evalWorld } from '../src/core/evaluate.js';
import { generateMotion, restArmAngle, MOTION_TYPES } from '../src/core/gait.js';

/** A T-posed character (built skeleton) must get arms hanging down, not sticking out sideways. */
export function generatedMotionOnTPoseRig() {
  const { rig } = tPoseCharacter();
  assert(restArmAngle(rig, 'L') > 60 && restArmAngle(rig, 'R') > 60, 'T-pose detected');
  for (const type of MOTION_TYPES) {
    const c = generateMotion(rig, type);
    const w = evalWorld(c, c.duration * 0.3, rig);
    for (const s of ['L', 'R']) {
      const sh = w.wp[rig.byKind.get(`upperarm.${s}`)];
      const el = w.wp[rig.byKind.get(`forearm.${s}`)];
      const d = el.clone().sub(sh);
      const side = (Math.atan2(Math.abs(d[rig.lateral]), -d.y) * 180) / Math.PI;
      assert(side < 40, `${type}: ${s} upper arm hangs down (${side.toFixed(0)}° from vertical)`);
    }
  }
}
