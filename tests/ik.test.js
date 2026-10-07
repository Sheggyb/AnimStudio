import * as THREE from 'three';
import { assert, near } from './helpers.js';
import { solveTwoBone, applyPole } from '../src/core/ik.js';

export function poleVectorSetsElbowDirection() {
  // T-pose arm along -X: shoulder at origin, elbow 0.21, wrist 0.39.
  const root = new THREE.Group();
  const up = new THREE.Bone(), lo = new THREE.Bone(), hand = new THREE.Bone();
  root.add(up);
  up.add(lo);
  lo.add(hand);
  lo.position.set(-0.21, 0, 0);
  hand.position.set(-0.18, 0, 0);
  // Start with the elbow bent UP (the bad case): the solver alone keeps that plane.
  lo.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6);
  root.updateMatrixWorld(true);
  const target = new THREE.Vector3(-0.1, -0.15, 0.2);
  solveTwoBone(up, lo, hand, target, { keepEndRotation: false });
  const pole = new THREE.Vector3(0, -1, 0);
  assert(applyPole(up, lo, hand, pole), 'pole applied');
  const w = (o) => o.getWorldPosition(new THREE.Vector3());
  near(w(hand).distanceTo(target), 0, 1e-4, 'hand stays on target');
  // Elbow offset from the shoulder->hand line points down.
  const a = w(up), c = w(hand), b = w(lo);
  const axis = c.clone().sub(a).normalize();
  const off = b.clone().sub(a);
  off.addScaledVector(axis, -off.dot(axis)).normalize();
  const want = pole.clone().addScaledVector(axis, -pole.dot(axis)).normalize();
  assert(off.dot(want) > 0.999, `elbow points along the pole (${off.dot(want).toFixed(4)})`);
}
