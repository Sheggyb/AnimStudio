import * as THREE from 'three';
import { assert, tPoseCharacter, mixamoRig } from './helpers.js';
import { evalWorld } from '../src/core/evaluate.js';
import { generateMotion, restArmAngle, MOTION_TYPES } from '../src/core/gait.js';
import { footReport } from '../src/core/contacts.js';
import { standardRig } from '../src/core/standard.js';

/** Generated gaits walk forwards: the ground under the planted foot moves back, and it doesn't slide. */
export function generatedGaitsWalkForwards() {
  for (const rig of [tPoseCharacter().rig, standardRig(), mixamoRig()]) {
    const fwd = new THREE.Vector3();
    fwd[rig.forwardAxis] = rig.forwardSign;
    for (const type of ['walk', 'jog', 'sneak', 'march', 'limp']) {
      const r = footReport(generateMotion(rig, type), rig);
      assert(r.heading && r.heading.dot(fwd) > 0.9, `${type} heads the way the character faces (${r.heading ? r.heading.dot(fwd).toFixed(2) : 'no heading'})`);
      assert(r.maxSlide < 0.01 * rig.height, `${type}: planted feet don't slide (${(r.maxSlide * 100).toFixed(1)} cm)`);
    }
  }
}

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
