// Retargeting: play an animation made for one skeleton on another (e.g. a Mixamo dance on a Meshy character).
// Bones are matched through the automatic anatomy labels, rotations are transferred in model
// space relative to each rig's rest pose, and hips motion is scaled by leg length.
import * as THREE from 'three';
import { frameTimes, makeChannel, makeQuatsContinuous } from './channel.js';
import { evalWorld } from './evaluate.js';
import { makeClip } from './clip.js';
import { reduceChannel } from './ops.js';

const DEG = Math.PI / 180;

/** dst bone index -> src bone index, matched by semantic label. Chains of different length are spread. */
export function buildBoneMap(src, dst, { fingers = true, extras = false, structural = true } = {}) {
  const map = new Map();
  for (let i = 0; i < dst.bones.length; i++) {
    const k = dst.kind[i];
    if (!k) continue;
    const head = k.split('.')[0];
    if (head === 'spine' || head === 'neck' || head === 'rootx') continue; // chains below
    if (head === 'finger' && !fingers) continue;
    if (head === 'extra' && !extras) continue;
    if (src.byKind.has(k)) map.set(i, src.byKind.get(k));
  }
  for (const chain of ['spine', 'neck']) {
    const a = src.chains[chain] || [];
    const b = dst.chains[chain] || [];
    if (!a.length || !b.length) continue;
    b.forEach((di, k) => {
      const si = a[b.length === 1 ? a.length - 1 : Math.round((k * (a.length - 1)) / (b.length - 1))];
      map.set(di, si);
    });
  }
  if (structural) matchByStructure(src, dst, map);
  return map;
}

/**
 * Bones without an anatomy label (cloth, tabards, hair, pads...) are matched structurally:
 * an unmatched bone whose parent is matched pairs with the source child of the matched
 * parent that sits at the most similar (height-normalised) offset. Runs parents-first, so
 * whole chains get matched.
 */
function matchByStructure(src, dst, map) {
  const used = new Set(map.values());
  const free = (k) => !k || k.startsWith('extra');
  for (const di of dst.order) {
    if (map.has(di) || dst.group[di] === 'attach' || !free(dst.kind[di])) continue;
    const dp = dst.parent[di];
    if (dp < 0 || !map.has(dp)) continue;
    const sp = map.get(dp);
    const off = dst.restWorld.p[di].clone().sub(dst.restWorld.p[dp]).divideScalar(dst.height);
    let best = -1,
      bd = 0.06;
    for (const sc of src.children[sp]) {
      if (used.has(sc) || !free(src.kind[sc])) continue;
      const d = src.restWorld.p[sc].clone().sub(src.restWorld.p[sp]).divideScalar(src.height).distanceTo(off);
      if (d < bd) [bd, best] = [d, sc];
    }
    if (best >= 0) {
      map.set(di, best);
      used.add(best);
    }
  }
}

function mainChildDir(rig, i) {
  // Direction from a bone to its "main" child in the rest pose (model space).
  const kids = rig.children[i];
  if (!kids.length) return null;
  let best = kids[0];
  for (const c of kids) if (rig.subtree(c).length > rig.subtree(best).length) best = c;
  const d = rig.restWorld.p[best].clone().sub(rig.restWorld.p[i]);
  return d.lengthSq() > 1e-10 ? d.normalize() : null;
}

/**
 * @param mode 'rotation' keeps the target's own proportions/pose style (copies rotations relative to rest);
 *             'direction' makes limbs point exactly where the source's do (more literal, can clip).
 */
/**
 * 'rotation' suits rigs with similar rest poses; when rest poses differ (arms down vs T-pose)
 * copying rotations twists limbs, so match limb directions instead.
 */
export function chooseMode(src, dst) {
  let worst = 0;
  for (const k of ['upperarm.L', 'upperarm.R', 'forearm.L', 'thigh.L', 'thigh.R', 'calf.L']) {
    const a = src.byKind.get(k),
      b = dst.byKind.get(k);
    if (a === undefined || b === undefined) continue;
    const da = mainChildDir(src, a),
      db = mainChildDir(dst, b);
    if (da && db) worst = Math.max(worst, (da.angleTo(db) * 180) / Math.PI);
  }
  return worst > 25 ? 'direction' : 'rotation';
}

/** Model-space rotation of bone i's parent at rest. */
const parentRestQ = (rig, i) => (rig.parent[i] < 0 ? rig.baseQ : rig.restWorld.q[rig.parent[i]]).clone();

export function retargetClip(srcClip, src, dst, { mode = 'auto', fps = 30, fingers = true, hipsScale = 'auto', tolerance = 0.05, name = null } = {}) {
  if (mode === 'auto') mode = chooseMode(src, dst);
  const map = buildBoneMap(src, dst, { fingers });
  const n = dst.bones.length;
  const times = srcClip.duration > 0 ? frameTimes(0, srcClip.duration, fps) : [0];

  // Rest corrections.
  const restCorr = new Array(n).fill(null);
  for (const [di, si] of map) {
    const srcRestInv = src.restWorld.q[si].clone().invert();
    let C = new THREE.Quaternion();
    // Limbs follow the source's directions; spine/neck/head keep the target's own posture
    // (otherwise an upright robot inherits e.g. an Orc's hunch).
    const limb = /^(upperarm|forearm|hand|thigh|calf|foot|toe)\./.test(dst.kind[di] || '');
    if (mode === 'direction' && limb) {
      const ds = mainChildDir(src, si);
      const dd = mainChildDir(dst, di);
      if (ds && dd) C.setFromUnitVectors(dd, ds);
    }
    // dstWorld(t) = srcWorld(t) * srcRest^-1 * C * dstRest
    restCorr[di] = { srcRestInv, tail: C.multiply(dst.restWorld.q[di]) };
  }

  const hipsS = src.special.hips;
  const hipsD = dst.special.hips;
  let scale = 1;
  if (hipsScale === 'auto' && hipsS >= 0 && hipsD >= 0) {
    const hs = src.restWorld.p[hipsS].y - src.ground;
    const hd = dst.restWorld.p[hipsD].y - dst.ground;
    if (hs > 1e-4) scale = hd / hs;
  } else if (typeof hipsScale === 'number') scale = hipsScale;

  const rot = Array.from({ length: n }, () => new Float32Array(times.length * 4));
  const hipsPos = new Float32Array(times.length * 3);
  const rootPos = new Float32Array(times.length * 3);
  const ws = { lq: [], lp: [], wq: [], wp: [] };
  const dW = Array.from({ length: n }, () => new THREE.Quaternion());
  const tmp = new THREE.Quaternion();
  const v = new THREE.Vector3();

  times.forEach((t, k) => {
    evalWorld(srcClip, t, src, ws);
    for (const i of dst.order) {
      const p = dst.parent[i];
      const parentW = p < 0 ? dst.baseQ : dW[p];
      const rc = restCorr[i];
      if (rc) dW[i].copy(ws.wq[map.get(i)]).multiply(rc.srcRestInv).multiply(rc.tail);
      else dW[i].copy(parentW).multiply(dst.rest[i].q);
      tmp.copy(parentW).invert().multiply(dW[i]).normalize();
      tmp.toArray(rot[i], k * 4);
    }
    // Hips & root translation: offset from rest, scaled.
    for (const [di, si, out] of [
      [hipsD, hipsS, hipsPos],
      [dst.special.root, src.special.root, rootPos],
    ]) {
      if (di < 0 || si < 0 || di == null || si == null) continue;
      // Offset from rest, taken through model space: skeletons can store it on different axes
      // (a Blender Z-up armature vs a Y-up game rig), so "down" must stay down.
      v.copy(ws.lp[si]).sub(src.rest[si].p).applyQuaternion(parentRestQ(src, si)).multiplyScalar(scale);
      v.applyQuaternion(parentRestQ(dst, di).invert()).add(dst.rest[di].p);
      v.toArray(out, k * 3);
    }
  });

  const clip = makeClip(name || srcClip.name, srcClip.duration);
  clip.loop = srcClip.loop;
  clip.events = srcClip.events.map((e) => ({ ...e }));
  clip.meta = { source: 'retarget', note: `retargeted (${mode})`, sourceName: srcClip.name };
  const base = clip.layers[0];
  const restCheck = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const ch = makeChannel('rot', times, rot[i]);
    makeQuatsContinuous(ch.values);
    if (tolerance > 0) reduceChannel(ch, tolerance * DEG);
    // Skip bones that never leave their rest rotation.
    let moving = false;
    for (let k = 0; k < ch.times.length && !moving; k++) moving = 1 - Math.abs(restCheck.fromArray(ch.values, k * 4).dot(dst.rest[i].q)) > 1e-7;
    if (moving) (base.tracks[dst.names[i]] ||= {}).rot = ch;
  }
  for (const [di, out, srcIdx] of [
    [hipsD, hipsPos, hipsS],
    [dst.special.root, rootPos, src.special.root],
  ]) {
    if (di == null || di < 0 || srcIdx == null || srcIdx < 0) continue;
    const srcHasPos = srcClip.layers.some((l) => l.tracks[src.names[srcIdx]]?.pos);
    if (!srcHasPos) continue;
    const ch = makeChannel('pos', times, out);
    if (tolerance > 0) reduceChannel(ch, 0.0005);
    (base.tracks[dst.names[di]] ||= {}).pos = ch;
  }
  return { clip, mapped: map.size, mode };
}
