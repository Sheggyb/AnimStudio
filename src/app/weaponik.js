// Weapon-driven posing: place the weapon, let IK put the hands on it. This is how game rigs hold
// guns — the weapon defines where the hands go, not the other way round.
import * as THREE from 'three';
import { app } from './state.js';
import { applyPose } from '../core/evaluate.js';
import { keyBone } from '../core/keying.js';
import { solveTwoBone, applyPole } from '../core/ik.js';
import { SMOOTH } from '../core/channel.js';

const DEG = Math.PI / 180;
const V = () => new THREE.Vector3();

/** Character axes (left, up, forward) in world space. */
function bodyAxes(rig) {
  const rootQ = app.model.root.getWorldQuaternion(new THREE.Quaternion());
  const left = V();
  left[rig.lateral] = rig.leftSign;
  const fwd = V();
  fwd[rig.forwardAxis] = rig.forwardSign;
  return { left: left.applyQuaternion(rootQ), up: new THREE.Vector3(0, 1, 0).applyQuaternion(rootQ), fwd: fwd.applyQuaternion(rootQ) };
}

function elbowHint(rig, side, elbow) {
  const ax = bodyAxes(rig);
  const out = ax.left.clone().multiplyScalar(side === 'L' ? 1 : -1);
  if (elbow === 'back') return ax.fwd.clone().negate().addScaledVector(out, 0.3);
  if (elbow === 'out') return out.addScaledVector(ax.up, -0.5);
  return ax.up.clone().negate().addScaledVector(out, 0.6).addScaledVector(ax.fwd, -0.2); // down
}

function propMatrix(p) {
  const e = new THREE.Euler(...(p.rot || [0, 0, 0]).map((d) => d * DEG));
  return new THREE.Matrix4().compose(V().fromArray(p.pos || [0, 0, 0]), new THREE.Quaternion().setFromEuler(e), V().setScalar(p.scale ?? 1));
}

/** The prop being held and its support grip (prop-local), from the prop view. */
export async function heldProp(propView, ref = null) {
  const props = app.project.props || [];
  const p = ref ? props.find((x) => x.name.toLowerCase() === String(ref).toLowerCase() || x.id === ref) : props.find((x) => /^Weapon_[RL]$/.test(x.socket) && x.visible !== false) || props[0];
  if (!p) throw new Error('No prop attached. Use attach_prop first.');
  await propView.sync();
  const obj = propView.live.get(p.id)?.obj;
  let support = null,
    inner = null;
  obj?.updateMatrixWorld(true);
  obj?.traverse((o) => {
    if (!support && o.userData?.support) {
      support = V().fromArray(o.userData.support);
      inner = o;
    }
    // File props: a node (e.g. a Blender Empty) named "Support", converted to prop-local space.
    if (!support && /^support/i.test(o.name || '')) support = obj.worldToLocal(o.getWorldPosition(V()));
  });
  // Per-prop override (prop-local units, e.g. a closer grip for characters with short arms).
  if (Array.isArray(p.support)) {
    support = V().fromArray(p.support);
    inner = null;
  }
  return { p, obj, support, inner };
}

function keyChain(d, li, rig, chain, t) {
  for (const i of chain) {
    const b = rig.bones[i];
    keyBone(d, li, rig.names[i], t, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }, rig.rest[i], { rot: true, pos: false, scl: false }, SMOOTH);
  }
}

/** Palm (grip point) in the hand bone's frame: the hand's weapon socket, else 40% to the hand tip. */
function palmLocal(rig, side) {
  const hand = rig.ik[`hand.${side}`].end;
  const sock = rig.byName.get(`Weapon_${side}`);
  if (sock !== undefined && rig.parent[sock] === hand) return rig.rest[sock].p.clone();
  const tip = rig.children[hand].find((c) => rig.group[c] !== 'attach');
  return tip !== undefined ? rig.rest[tip].p.clone().multiplyScalar(0.4) : V();
}

/**
 * IK the support hand so its PALM lands on the held prop's grip at the current pose. A few
 * passes correct for the hand's own length. Returns the remaining miss in metres.
 */
function solveSupport(rig, held, propView, side, elbow, targetOverride = null) {
  const ik = rig.ik[`hand.${side}`];
  const hand = rig.bones[ik.end];
  propView.update();
  held.obj.updateMatrixWorld(true);
  const target = targetOverride ? targetOverride.clone() : held.support.clone().applyMatrix4((held.inner || held.obj).matrixWorld);
  const palm = palmLocal(rig, side);
  const aim = target.clone();
  let miss = Infinity;
  for (let k = 0; k < 4; k++) {
    const hint = elbowHint(rig, side, elbow);
    solveTwoBone(rig.bones[ik.upper], rig.bones[ik.lower], hand, aim, { bendHint: hint, keepEndRotation: false });
    applyPole(rig.bones[ik.upper], rig.bones[ik.lower], hand, hint);
    hand.updateWorldMatrix(true, false);
    const p = palm.clone().applyMatrix4(hand.matrixWorld);
    miss = p.distanceTo(target);
    if (miss < 0.002) break;
    aim.add(target.clone().sub(p));
  }
  return miss;
}

/**
 * poses: [{ frame, grip: [left, up, forward] metres from the chest, aim: [yaw°(+left), pitch°(+up)], roll° }]
 *    or  [{ frame, main: [l,u,f], support: [l,u,f], roll° }] — palms on their own sides, weapon between them.
 * Solves the main arm so the weapon sits there, then the support arm onto the weapon, and keys both.
 */
export async function keyWeaponPoses(clip, poses, { propView, prop = null, support = true, supportSide = null, elbow = 'down', supportElbow = 'down', layer = null } = {}) {
  const rig = app.rig;
  const held = await heldProp(propView, prop);
  const side = held.p.socket === 'Weapon_L' ? 'L' : 'R';
  const sSide = supportSide || (side === 'R' ? 'L' : 'R');
  const sock = rig.byName.get(held.p.socket);
  if (sock === undefined) throw new Error(`Socket ${held.p.socket} missing`);
  const ik = rig.ik[`hand.${side}`];
  if (rig.parent[sock] !== ik.end) throw new Error(`${held.p.socket} must hang from the ${side} hand`);
  const sockLocal = new THREE.Matrix4().compose(rig.rest[sock].p, rig.rest[sock].q, rig.rest[sock].s);
  const offInv = propMatrix(held.p).invert();
  const li = layer != null ? Math.max(0, clip.layers.findIndex((l) => l.name === layer || l.id === layer)) : app.layerIndex;
  const chain = [ik.upper, ik.lower, ik.end];
  const report = { frames: [], out_of_reach: [] };
  const fps = app.fps;
  app.edit(
    'AI: weapon pose',
    (d) => {
      for (const ps of poses) {
        const t = Math.min(d.duration, Math.max(0, (ps.frame ?? 0) / fps));
        applyPose(d, t, rig);
        app.model.root.updateMatrixWorld(true);
        const ax = bodyAxes(rig);
        const chest = rig.bones[rig.special.chest].getWorldPosition(V());
        const at = (v) => chest.clone().addScaledVector(ax.left, v[0]).addScaledVector(ax.up, v[1]).addScaledVector(ax.fwd, v[2]);
        // Hands mode: each palm placed on its own side (elbows do the work), the weapon runs
        // from the main palm through the support palm. Otherwise: grip position + aim angles.
        const handsMode = Array.isArray(ps.main) && Array.isArray(ps.support);
        const pos = at(handsMode ? ps.main : ps.grip || [-0.1, -0.25, 0.25]);
        const supportAt = handsMode ? at(ps.support) : null;
        // Weapon frame: +Z along aim, +Y up (rolled).
        const [yaw, pitch] = ps.aim || [0, 0];
        let z;
        if (handsMode) z = supportAt.clone().sub(pos).normalize();
        else {
          z = ax.fwd.clone().applyAxisAngle(ax.up, yaw * DEG);
          z.applyAxisAngle(V().crossVectors(ax.up, z).normalize(), -pitch * DEG);
        }
        let y = ax.up.clone().addScaledVector(z, -ax.up.dot(z)).normalize();
        y.applyAxisAngle(z, (ps.roll || 0) * DEG);
        const x = V().crossVectors(y, z).normalize();
        y = V().crossVectors(z, x).normalize();
        const W = new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);
        // Weapon -> socket -> hand.
        const S = W.clone().multiply(offInv);
        const handW = S.multiply(sockLocal.clone().invert());
        const hp = V(),
          hq = new THREE.Quaternion(),
          hs = V();
        handW.decompose(hp, hq, hs);
        const hand = rig.bones[ik.end];
        const hint = elbowHint(rig, side, ps.elbow || elbow);
        solveTwoBone(rig.bones[ik.upper], rig.bones[ik.lower], hand, hp, { bendHint: hint, keepEndRotation: false });
        applyPole(rig.bones[ik.upper], rig.bones[ik.lower], hand, hint);
        hand.parent.updateWorldMatrix(true, false);
        hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(hq));
        hand.updateWorldMatrix(false, true);
        const reached = hand.getWorldPosition(V()).distanceTo(hp) <= 0.02 * rig.height;
        keyChain(d, li, rig, chain, t);
        let supMiss = 0;
        if (support && held.support && rig.ik[`hand.${sSide}`]) {
          supMiss = solveSupport(rig, held, propView, sSide, ps.supportElbow || supportElbow, supportAt);
          const s = rig.ik[`hand.${sSide}`];
          keyChain(d, li, rig, [s.upper, s.lower, s.end], t);
        }
        report.frames.push(ps.frame ?? 0);
        const mainMiss = hand.getWorldPosition(V()).distanceTo(hp);
        if (!reached || supMiss > 0.015) report.out_of_reach.push({ frame: ps.frame ?? 0, main_miss_cm: +(mainMiss * 100).toFixed(1), support_miss_cm: +(supMiss * 100).toFixed(1) });
      }
    },
    { clipId: clip.id }
  );
  return report;
}

/** Support hand only, at given times (keeps whatever the main hand does). */
export async function keySupportHand(clip, frames, { propView, prop = null, side = 'L', elbow = 'down', layer = null } = {}) {
  const rig = app.rig;
  const held = await heldProp(propView, prop);
  if (!held.support) throw new Error(`"${held.p.name}" has no support grip (add a node named "Support" to the GLB).`);
  const ik = rig.ik[`hand.${side}`];
  const li = layer != null ? Math.max(0, clip.layers.findIndex((l) => l.name === layer || l.id === layer)) : app.layerIndex;
  const misses = [];
  app.edit(
    'AI: support hand IK',
    (d) => {
      for (const f of frames) {
        const t = Math.min(d.duration, Math.max(0, f / app.fps));
        applyPose(d, t, rig);
        app.model.root.updateMatrixWorld(true);
        const miss = solveSupport(rig, held, propView, side, elbow);
        if (miss > 0.015) misses.push({ frame: f, miss_cm: +(miss * 100).toFixed(1) });
        keyChain(d, li, rig, [ik.upper, ik.lower, ik.end], t);
      }
    },
    { clipId: clip.id }
  );
  return { keyed_frames: frames, prop: held.p.name, out_of_reach: misses };
}

/**
 * Limb IK targets for posing: hands relative to the chest, feet relative to the root (on the
 * ground under the character), both as [left, up, forward] metres in the character's frame.
 * Solves at the current (already applied) pose and returns the bone indices it changed.
 * targets: { 'hand.R': [l,u,f], 'foot.L': [l,u,f], ... }  poles: { 'hand.R': 'down'|'out'|'back' }
 */
export function solveLimbTargets(rig, targets, poles = {}) {
  const ax = bodyAxes(rig);
  const chest = rig.bones[rig.special.chest].getWorldPosition(V());
  const rootI = rig.special.root >= 0 ? rig.special.root : rig.special.hips;
  const root = rig.bones[rootI].getWorldPosition(V());
  const changed = [];
  const misses = {};
  for (const [limb, v] of Object.entries(targets)) {
    const [kind, side] = limb.split('.');
    const ik = rig.ik[`${kind}.${side}`];
    if (!ik || !Array.isArray(v)) continue;
    const base = kind === 'hand' ? chest : root;
    const target = base.clone().addScaledVector(ax.left, v[0]).addScaledVector(ax.up, v[1]).addScaledVector(ax.fwd, v[2]);
    let hint;
    if (kind === 'hand') hint = elbowHint(rig, side, poles[limb] || 'down');
    else hint = ax.fwd.clone().addScaledVector(ax.left, (side === 'L' ? 1 : -1) * 0.15); // knees forward, slightly out
    const end = rig.bones[ik.end];
    const keep = end.getWorldQuaternion(new THREE.Quaternion());
    solveTwoBone(rig.bones[ik.upper], rig.bones[ik.lower], end, target, { bendHint: hint, keepEndRotation: false });
    applyPole(rig.bones[ik.upper], rig.bones[ik.lower], end, hint);
    // Feet keep their world orientation (flat on the ground); hands follow the forearm.
    if (kind === 'foot') {
      end.parent.updateWorldMatrix(true, false);
      end.quaternion.copy(end.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(keep));
    }
    end.updateWorldMatrix(true, true);
    misses[limb] = +(end.getWorldPosition(V()).distanceTo(target) * 100).toFixed(1);
    changed.push(ik.upper, ik.lower, ik.end);
  }
  return { changed, misses };
}
