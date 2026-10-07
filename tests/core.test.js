import * as THREE from 'three';
import path from 'node:path';
import { assert, near, quatNear, model, rigFiles, exists, needs, ROOT, PACK, PACK2, MIXAMO } from './helpers.js';
import { loadGlb } from './glb-node.js';
import { makeChannel, setKey, sample, findKey, retimeKeys, removeKeys, LINEAR, SMOOTH, EASE, STEP, frameTimes } from '../src/core/channel.js';
import { makeClip, makeLayer, cloneClip, bakeToThree, clipFromThree, serializeClip, deserializeClip, getTrack } from '../src/core/clip.js';
import { evalBone, makeXform, applyPose, evalWorld } from '../src/core/evaluate.js';
import { keyBone } from '../src/core/keying.js';
import { solveTwoBone, bendHintFor } from '../src/core/ik.js';
import { makeScratchSkeleton, analyzeRig } from '../src/core/rig.js';
import * as ops from '../src/core/ops.js';
import { retargetClip } from '../src/core/retarget.js';
import { motionProfile, keyPoseTimes, loopError } from '../src/core/analysis.js';
import { serializeProject, deserializeProject } from '../src/core/project.js';

const q = (x, y, z, order) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));

export function channelInsertReplaceRemove() {
  const c = makeChannel('pos');
  setKey(c, 1, [1, 0, 0]);
  setKey(c, 0, [0, 0, 0]);
  setKey(c, 0.5, [5, 0, 0]);
  setKey(c, 0.5, [0.5, 0, 0]); // replace
  assert(c.times.length === 3, 'three keys');
  near(c.times[1], 0.5);
  near(c.values[3], 0.5);
  near(sample(c, 0.25, [0, 0, 0])[0], 0.25);
  removeKeys(c, [findKey(c, 0.5)]);
  assert(c.times.length === 2);
  near(sample(c, 0.5, [0, 0, 0])[0], 0.5);
}

export function interpolationModes() {
  const c = makeChannel('pos', [0, 1, 2], [0, 0, 0, 1, 0, 0, 0, 0, 0], STEP);
  near(sample(c, 0.9, [0, 0, 0])[0], 0, 1e-6, 'step holds');
  c.interp.fill(EASE);
  near(sample(c, 0.5, [0, 0, 0])[0], 0.5, 1e-6, 'ease midpoint');
  near(sample(c, 0.25, [0, 0, 0])[0], 0.15625, 1e-6, 'ease curve');
  c.interp.fill(SMOOTH);
  // Monotone cubic never overshoots the extreme key.
  let max = 0;
  for (let t = 0; t <= 2; t += 0.01) max = Math.max(max, sample(c, t, [0, 0, 0])[0]);
  near(max, 1, 1e-6, 'no overshoot');
  // Rotation smooth stays normalised.
  const r = makeChannel('rot', [0, 1, 2], [...q(0, 0, 0).toArray(), ...q(1, 0.3, 0).toArray(), ...q(0.2, 1, 0).toArray()], SMOOTH);
  const o = sample(r, 0.7, [0, 0, 0, 0]);
  near(Math.hypot(...o), 1, 1e-6, 'unit quaternion');
}

export function retimeMovesAndOverwrites() {
  const c = makeChannel('pos', [0, 1, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0]);
  retimeKeys(c, [2], (t) => t - 1); // move key at 2 onto 1
  assert(c.times.length === 2, 'collision resolved');
  near(c.values[3], 2, 1e-6, 'moved key wins');
}

export function originalClipsBakeExactly() {
  const m = model();
  const walk = m.clip('Walk_Loop');
  assert(walk && walk.duration > 0, 'Walk_Loop exists');
  const tc = bakeToThree(walk, m.rig, evalBone, { fps: 30 });
  const orig = m.clips.indexOf(walk);
  const src = m.json.animations[orig];
  assert(tc.tracks.length > 0 && tc.tracks.length <= src.channels.length, 'track count');
  // Every baked value matches evaluation of the original data.
  const x = makeXform();
  for (const tr of tc.tracks.slice(0, 20)) {
    const bone = tr.name.slice(0, tr.name.lastIndexOf('.')); // bone names may contain dots (DEF-spine.001)
    const i = m.rig.byName.get(bone);
    for (let k = 0; k < tr.times.length; k += 7) {
      evalBone(walk, bone, tr.times[k], m.rig.rest[i], x);
      if (tr.name.endsWith('quaternion')) quatNear(new THREE.Quaternion().fromArray(tr.values, k * 4), x.q, 1e-3);
    }
  }
}

export function keyingThroughLayers() {
  const m = model();
  const clip = cloneClip(m.clip('Jog_Fwd_Loop'), true);
  const bone = m.rig.names[m.rig.byKind.get('upperarm.L')];
  const i = m.rig.byName.get(bone);
  const add = makeLayer('Tweak', 'additive');
  add.weight = 0.6;
  const over = makeLayer('Over', 'override');
  over.weight = 0.5;
  clip.layers.push(add, over);
  const target = { p: m.rig.rest[i].p.clone(), q: q(0.4, -0.2, 0.9), s: new THREE.Vector3(1, 1, 1) };
  for (const li of [0, 1, 2]) {
    keyBone(clip, li, bone, 0.3, target, m.rig.rest[i]);
    const x = evalBone(clip, bone, 0.3, m.rig.rest[i], makeXform());
    // Override layers above (li < 2) blend toward their own keys, so only check exactness when
    // nothing above overrides this bone.
    if (li === 2 || !clip.layers[2].tracks[bone]) quatNear(x.q, target.q, 0.01, `layer ${li}`);
  }
}

export async function twoBoneIKReachesTargets() {
  // On a pack's skeleton when there is one, else on AnimStudio's standard skeleton.
  const m = exists(PACK) ? model() : { rig: (await import('../src/core/standard.js')).standardRig() };
  const sk = makeScratchSkeleton(m.rig);
  for (const limb of ['hand.L', 'hand.R', 'foot.L', 'foot.R']) {
    const ik = m.rig.ik[limb];
    assert(ik, `${limb} chain`);
    const [u, l, e] = [sk.bones[ik.upper], sk.bones[ik.lower], sk.bones[ik.end]];
    const a = u.getWorldPosition(new THREE.Vector3());
    const reach = a.distanceTo(l.getWorldPosition(new THREE.Vector3())) + l.getWorldPosition(new THREE.Vector3()).distanceTo(e.getWorldPosition(new THREE.Vector3()));
    for (let k = 0; k < 20; k++) {
      const dir = new THREE.Vector3(Math.sin(k * 1.7), Math.cos(k * 0.9) * 0.8, Math.sin(k * 2.3 + 1)).normalize();
      const target = a.clone().addScaledVector(dir, reach * (0.35 + 0.6 * ((k * 0.37) % 1)));
      solveTwoBone(u, l, e, target, { bendHint: bendHintFor(m.rig, ik.bend) });
      const got = e.getWorldPosition(new THREE.Vector3());
      near(got.distanceTo(target), 0, 1e-3, `${limb} reach ${k}`);
    }
  }
}

export function opsReverseTwiceIsIdentity() {
  const m = model();
  const c = cloneClip(m.clip('Sword_Attack'), true);
  const before = evalBone(c, m.rig.names[m.rig.byKind.get('forearm.R')], 0.37, m.rig.rest[m.rig.byKind.get('forearm.R')], makeXform()).q.clone();
  ops.reverse(c);
  ops.reverse(c);
  const after = evalBone(c, m.rig.names[m.rig.byKind.get('forearm.R')], 0.37, m.rig.rest[m.rig.byKind.get('forearm.R')], makeXform()).q;
  quatNear(after, before, 1e-3);
}

export function opsMirrorTwiceIsIdentity() {
  const m = model();
  const c = cloneClip(m.clip('Sword_Attack'), true);
  const ctx = { rig: m.rig };
  const bone = m.rig.byKind.get('upperarm.R');
  const before = evalBone(c, m.rig.names[bone], 1.0, m.rig.rest[bone], makeXform()).q.clone();
  ops.mirrorClip(c, ctx);
  // After one mirror the waving arm is the left one.
  const leftNow = evalBone(c, m.rig.names[m.rig.mirror[bone]], 1.0, m.rig.rest[m.rig.mirror[bone]], makeXform()).q;
  quatNear(leftNow, new THREE.Quaternion(before.x, -before.y, -before.z, before.w), 1e-3, 'mirrored rotation');
  ops.mirrorClip(c, ctx);
  quatNear(evalBone(c, m.rig.names[bone], 1.0, m.rig.rest[bone], makeXform()).q, before, 1e-3, 'round trip');
}

export function opsLoopFixMatchesEnds() {
  const m = model();
  const c = cloneClip(m.clip('Punch_Cross'), true);
  ops.loopFix(c, { rig: m.rig }, { frames: 8 });
  assert(c.loop, 'loop flag');
  const err = loopError(c, m.rig);
  assert(err.angle < 0.05, `loop angle error ${err.angle}`);
}

export function opsReduceKeysWithinTolerance() {
  const m = model();
  const c = cloneClip(m.clip('Jog_Fwd_Loop'), true);
  const ref = cloneClip(c, true);
  const before = c.layers[0].tracks;
  let n0 = 0;
  for (const b in before) for (const k in before[b]) n0 += before[b][k].times.length;
  ops.reduceKeys(c, { rig: m.rig }, { angle: 0.5 });
  let n1 = 0;
  for (const b in c.layers[0].tracks) for (const k in c.layers[0].tracks[b]) n1 += c.layers[0].tracks[b][k].times.length;
  assert(n1 < n0, `fewer keys ${n0} -> ${n1}`);
  const i = m.rig.byKind.get('thigh.L');
  for (let t = 0; t < c.duration; t += 0.05) {
    const a = evalBone(ref, m.rig.names[i], t, m.rig.rest[i], makeXform()).q.clone();
    const b = evalBone(c, m.rig.names[i], t, m.rig.rest[i], makeXform()).q;
    quatNear(b, a, 1.0, `t=${t.toFixed(2)}`);
  }
}

export function opsTimingAndCombine() {
  const m = model();
  const ctx = { rig: m.rig };
  const w = cloneClip(m.clip('Walk_Loop'), true);
  const r = cloneClip(m.clip('Jog_Fwd_Loop'), true);
  const d0 = w.duration;
  ops.scaleTime(w, 2);
  near(w.duration, d0 * 2, 1e-5, 'scaled');
  ops.trim(w, 0.2, 1.0);
  near(w.duration, 0.8, 1e-5, 'trimmed');
  ops.insertHold(w, 0.4, 0.25);
  near(w.duration, 1.05, 1e-5, 'hold inserted');
  const cat = ops.concatClips(w, r, ctx, { blend: 6 });
  near(cat.duration, w.duration + r.duration - 0.2, 1e-4, 'concat duration');
  const bl = ops.blendClips(m.clip('Walk_Loop'), m.clip('Jog_Fwd_Loop'), ctx, { weight: 0.5 });
  near(bl.duration, (m.clip('Walk_Loop').duration + m.clip('Jog_Fwd_Loop').duration) / 2, 1e-4, 'blend duration');
  const base = cloneClip(m.clip('Jog_Fwd_Loop'), true);
  const L = ops.addClipAsLayer(base, m.clip('Sword_Attack'), ctx, { mode: 'override', mask: m.rig.names.filter((_, i) => m.rig.group[i] === 'arm.R') });
  assert(Object.keys(L.tracks).length > 0, 'layer has tracks');
  ops.bakeLayers(base, ctx);
  assert(base.layers.length === 1, 'baked to one layer');
}

export function opsModifiersRun() {
  const m = model();
  const ctx = { rig: m.rig, li: 0, bones: null, range: null };
  const c = cloneClip(m.clip('Idle_Loop'), true);
  ops.amplify(c, ctx, { factor: 2 });
  ops.smooth(c, ctx, { radius: 3 });
  ops.addNoise(c, { ...ctx, bones: new Set([m.rig.names[m.rig.special.head]]) }, { amount: 4 });
  ops.timeOffset(c, { ...ctx, bones: new Set([m.rig.names[m.rig.byKind.get('upperarm.L')]]) }, { frames: 4 });
  ops.resample(c, ctx, { fps: 10 });
  ops.lockFeet(cloneClip(m.clip('Jog_Fwd_Loop'), true), { rig: m.rig, li: 0, range: [0.1, 0.4] });
  const x = makeXform();
  for (const b of m.rig.names.slice(0, 40)) {
    evalBone(c, b, 0.5, m.rig.rest[m.rig.byName.get(b)], x);
    assert(Number.isFinite(x.q.x + x.q.y + x.q.z + x.q.w + x.p.x + x.p.y + x.p.z), 'finite');
  }
}

export function keyPosesFromMotion() {
  const m = model();
  const c = m.clip('Punch_Cross');
  const prof = motionProfile(c, m.rig);
  const times = keyPoseTimes(prof);
  assert(times.length >= 3 && times[0] === 0, `key poses ${times}`);
  const kp = ops.keyPosesClip(c, { rig: m.rig }, times);
  assert(Object.keys(kp.layers[0].tracks).length > 10, 'key pose clip has tracks');
}

export function retargetAcrossRigs() {
  const src = model();
  for (const f of rigFiles().filter((f) => f !== PACK)) {
    const dst = model(f);
    for (const mode of ['rotation', 'direction']) {
      const { clip, mapped } = retargetClip(src.clip('Dance_Loop'), src.rig, dst.rig, { mode });
      assert(mapped >= 20, `${f} mapped ${mapped}`);
      const ws = evalWorld(clip, 0.5, dst.rig);
      for (const p of ws.wp) assert(Number.isFinite(p.x + p.y + p.z), 'finite');
      // Feet stay near the ground-ish range of the target (no explosion).
      const foot = dst.rig.byKind.get('foot.L');
      assert(Math.abs(ws.wp[foot].y - dst.rig.ground) < dst.rig.height * 0.6, `${f} ${mode} foot height ${ws.wp[foot].y}`);
    }
  }
}

export function allModelsHaveFullRigs() {
  needs(PACK);
  for (const f of rigFiles()) {
    const m = model(f);
    for (const k of ['hips', 'chest', 'head', 'hand.L', 'hand.R', 'foot.L', 'foot.R', 'upperarm.L', 'thigh.R']) assert(m.rig.byKind.has(k), `${f} missing ${k}`);
    assert(m.rig.humanoid, `${f} humanoid`);
  }
}

export function serializationRoundTrip() {
  const m = model();
  const c = cloneClip(m.clip('Jog_Fwd_Loop'), true);
  c.layers.push(makeLayer('Add', 'additive'));
  setKey(getTrack(c.layers[1], m.rig.names[5], 'rot', true), 0.2, [0, 0, 0.1, 0.995], SMOOTH);
  c.events.push({ t: 0.3, name: 'footstep' });
  const back = deserializeClip(JSON.parse(JSON.stringify(serializeClip(c))));
  assert(back.layers.length === 2 && back.events[0].name === 'footstep', 'structure');
  const i = m.rig.byKind.get('calf.L');
  quatNear(evalBone(back, m.rig.names[i], 0.33, m.rig.rest[i], makeXform()).q, evalBone(c, m.rig.names[i], 0.33, m.rig.rest[i], makeXform()).q, 1e-3);

  const originals = new Map(m.clips.map((x) => [x.meta.originalName, x]));
  const proj = serializeProject({ model: PACK, clips: [m.clips[0], c], originals, excluded: new Set([c.id]), nick: { bone_1: 'x' } });
  assert(proj.clips[0].ref && proj.clips[1].data, 'refs + data');
  const restored = deserializeProject(JSON.parse(JSON.stringify(proj)), originals);
  assert(restored.clips[0] === m.clips[0] && restored.excluded.size === 1, 'restored');
}

export function retargetOntoSameRigIsIdentity() {
  const m = model();
  for (const name of ['Walk_Loop', 'Sword_Attack', 'Dance_Loop']) {
    const src = m.clip(name);
    if (!src) continue;
    const { clip } = retargetClip(src, m.rig, m.rig, { mode: 'rotation', tolerance: 0 });
    for (const t of [0, src.duration * 0.37, src.duration * 0.81]) {
      for (const i of m.rig.core) {
        const a = evalBone(src, m.rig.names[i], t, m.rig.rest[i], makeXform()).q.clone();
        const b = evalBone(clip, m.rig.names[i], t, m.rig.rest[i], makeXform()).q;
        quatNear(b, a, 0.5, `${name} ${m.rig.labels[i] || m.rig.names[i]} t=${t.toFixed(2)}`);
      }
      const hips = m.rig.special.hips;
      const pa = evalBone(src, m.rig.names[hips], t, m.rig.rest[hips], makeXform()).p.clone();
      const pb = evalBone(clip, m.rig.names[hips], t, m.rig.rest[hips], makeXform()).p;
      near(pa.distanceTo(pb), 0, 1e-3, `${name} hips position`);
    }
  }
}

export function easeTimingKeepsEnds() {
  const m = model();
  const c = cloneClip(m.clip('Sword_Attack'), true);
  const i = m.rig.byKind.get('forearm.R');
  const a0 = evalBone(c, m.rig.names[i], 0, m.rig.rest[i], makeXform()).q.clone();
  const a1 = evalBone(c, m.rig.names[i], c.duration, m.rig.rest[i], makeXform()).q.clone();
  ops.easeTiming(c, { rig: m.rig }, { mode: 'inout', strength: 1 });
  quatNear(evalBone(c, m.rig.names[i], 0, m.rig.rest[i], makeXform()).q, a0, 0.01, 'start');
  quatNear(evalBone(c, m.rig.names[i], c.duration, m.rig.rest[i], makeXform()).q, a1, 0.01, 'end');
  // eased: on the frame near 25% we are earlier in the motion than before (re-keyed per frame,
  // so check on a frame, not between two)
  const t = Math.round(c.duration * 0.25 * 30) / 30;
  const u = t / c.duration;
  const nowMid = evalBone(c, m.rig.names[i], t, m.rig.rest[i], makeXform()).q;
  const earlier = evalBone(m.clip('Sword_Attack'), m.rig.names[i], c.duration * u * u * (3 - 2 * u), m.rig.rest[i], makeXform()).q;
  quatNear(nowMid, earlier, 0.5, 'warped time');
  assert(c.duration === m.clip('Sword_Attack').duration, 'length unchanged');
}

export function mixamoNamesAreRecognised() {
  const P = {
    'mixamorig:Hips': [null, 0, 1, 0], 'mixamorig:Spine': ['mixamorig:Hips', 0, 0.1, 0], 'mixamorig:Spine1': ['mixamorig:Spine', 0, 0.1, 0],
    'mixamorig:Spine2': ['mixamorig:Spine1', 0, 0.1, 0], 'mixamorig:Neck': ['mixamorig:Spine2', 0, 0.15, 0], 'mixamorig:Head': ['mixamorig:Neck', 0, 0.1, 0],
    'mixamorig:HeadTop_End': ['mixamorig:Head', 0, 0.2, 0],
  };
  for (const [s, x] of [['Left', 1], ['Right', -1]]) {
    Object.assign(P, {
      [`mixamorig:${s}Shoulder`]: ['mixamorig:Spine2', 0.05 * x, 0.1, 0], [`mixamorig:${s}Arm`]: [`mixamorig:${s}Shoulder`, 0.12 * x, 0, 0],
      [`mixamorig:${s}ForeArm`]: [`mixamorig:${s}Arm`, 0.25 * x, 0, 0], [`mixamorig:${s}Hand`]: [`mixamorig:${s}ForeArm`, 0.25 * x, 0, 0],
      [`mixamorig:${s}HandIndex1`]: [`mixamorig:${s}Hand`, 0.08 * x, 0, 0.02],
      [`mixamorig:${s}UpLeg`]: ['mixamorig:Hips', 0.1 * x, -0.05, 0], [`mixamorig:${s}Leg`]: [`mixamorig:${s}UpLeg`, 0, -0.45, 0],
      [`mixamorig:${s}Foot`]: [`mixamorig:${s}Leg`, 0, -0.42, 0], [`mixamorig:${s}ToeBase`]: [`mixamorig:${s}Foot`, 0, -0.06, 0.12],
    });
  }
  const root = new THREE.Group();
  const bones = {};
  for (const [n, [p, x, y, z]] of Object.entries(P)) {
    const b = new THREE.Bone();
    b.name = n;
    b.position.set(x, y, z);
    bones[n] = b;
  }
  for (const [n, [p]] of Object.entries(P)) (p ? bones[p] : root).add(bones[n]);
  root.updateMatrixWorld(true);
  const rig = analyzeRig(root, Object.values(bones));
  assert(rig.humanoid && rig.namedRig, 'humanoid from names');
  for (const [k, n] of [['upperarm.L', 'mixamorig:LeftArm'], ['calf.R', 'mixamorig:RightLeg'], ['chest', 'mixamorig:Spine2'], ['toe.L', 'mixamorig:LeftToeBase'], ['finger.L.1.0', 'mixamorig:LeftHandIndex1']])
    assert(rig.names[rig.byKind.get(k)] === n, `${k} -> ${rig.names[rig.byKind.get(k)]}`);
  assert(rig.mirror[rig.byKind.get('hand.L')] === rig.byKind.get('hand.R'), 'mirror pair');
}

export function unnamedBonesAreLabelledByShape() {
  // Bones named bone_0, bone_1… (as some exporters write them) are labelled from the skeleton's
  // shape alone, and land on the same bones the names give.
  // Quaternius: spine and legs branch off one hips bone, head has no end bone.
  // Mixamo: separate spine chain, HeadTop_End above the head.
  for (const f of [PACK, MIXAMO].filter(exists)) {
    const named = model(f).rig;
    const g = loadGlb(path.join(ROOT, f));
    g.bones.forEach((b, i) => (b.name = `bone_${i}`));
    const rig = analyzeRig(g.scene, g.bones, g.box);
    assert(rig.humanoid && !rig.namedRig, `${f} humanoid from geometry`);
    for (const k of ['head', 'chest', 'upperarm.L', 'forearm.R', 'hand.L', 'hand.R', 'thigh.L', 'calf.R', 'foot.L', 'foot.R'])
      assert(rig.byKind.get(k) === named.byKind.get(k), `${f} ${k}: ${named.names[rig.byKind.get(k)]} vs ${named.names[named.byKind.get(k)]}`);
    assert(rig.mirror[rig.byKind.get('hand.L')] === rig.byKind.get('hand.R'), 'mirror pair');
  }
}

export async function styleEngine() {
  const { applyStyle } = await import('../src/core/style.js');
  const m = model();
  const walk = m.clip('Walk_Loop');
  const s = applyStyle(walk, m.rig, { speed: 2 });
  near(s.duration, walk.duration / 2, 1e-4, 'speed halves duration');
  const all = applyStyle(walk, m.rig, { intensity: 1.3, arms: 1.5, legs: 1.2, bounce: 2, lean: 15, armsOut: 10, headNod: 10, headTurn: 20, smooth: 2, life: 2, mirror: true });
  const ws = evalWorld(all, 0.4, m.rig);
  for (const p of ws.wp) assert(Number.isFinite(p.x + p.y + p.z), 'finite');
  // Crouch: hips go down, feet stay where they were.
  const c = applyStyle(walk, m.rig, { crouch: 0.5 });
  for (const t of [0.1, 0.5]) {
    const a = evalWorld(walk, t, m.rig);
    const footA = a.wp[m.rig.byKind.get('foot.L')].clone();
    const hipsA = a.wp[m.rig.special.hips].y;
    const b = evalWorld(c, t, m.rig);
    assert(b.wp[m.rig.special.hips].y < hipsA - 0.1, 'hips lowered');
    near(b.wp[m.rig.byKind.get('foot.L')].distanceTo(footA), 0, 0.01, `foot planted t=${t}`);
  }
  // Lean forward moves the head forward.
  const lean = applyStyle(walk, m.rig, { lean: 25 });
  const h0 = evalWorld(walk, 0.2, m.rig).wp[m.rig.special.head].clone();
  const h1 = evalWorld(lean, 0.2, m.rig).wp[m.rig.special.head];
  assert((h1.z - h0.z) * m.rig.forwardSign > 0.1, `head forward ${h1.z - h0.z}`);
}

export async function standardLibraryCore() {
  const S = await import('../src/core/standard.js');
  const { rangeOfMotion } = await import('../src/core/analysis.js');
  const std = S.standardRig();
  assert(std.humanoid && std.bones.length === 27, `standard rig ${std.bones.length}`);
  // pack walk -> standard rig
  const toStd = (m, name) => retargetClip(m.clip(name), m.rig, std, { mode: 'auto' }).clip;
  const human = toStd(model(), 'Walk_Loop');
  // averaging a clip with itself is the clip
  const same = S.averageClips([human, human], std, { tolerance: 0 });
  const th = std.byKind.get('thigh.L');
  for (const t of [0.2, 0.6])
    quatNear(evalBone(same, std.names[th], t * same.duration, std.rest[th], makeXform()).q, evalBone(human, std.names[th], t * human.duration, std.rest[th], makeXform()).q, 0.5, 'self-average');
  // phase: a shifted copy is detected
  const shifted = cloneClip(human, true);
  ops.timeOffset(shifted, { rig: std }, { frames: Math.round(human.duration * 30 * 0.25) });
  const s = S.phaseShift(human, shifted, std);
  assert(Math.abs(s - 0.75) < 0.06 || Math.abs(s - 0.25) < 0.06, `phase ${s}`);
  // walks from several rigs -> one walk that still swings the legs
  const walks = [[PACK, 'Walk_Loop'], [PACK, 'Walk_Formal_Loop'], [PACK2, 'Walk_Carry_Loop'], [MIXAMO, 'Walking']].filter(([f]) => exists(f));
  const avg = S.averageClips(walks.map(([f, n]) => toStd(model(f), n)), std, { name: 'Walk', loop: true });
  const rom = rangeOfMotion(avg, std, th);
  const swing = Math.max(...rom.max.map((v, k) => v - rom.min[k]));
  assert(avg.loop && swing > 20, `averaged walk keeps a stride (${swing.toFixed(1)}°)`);
}

export async function generatedMotionsAreAnatomical() {
  const { generateMotion, MOTION_TYPES } = await import('../src/core/gait.js');
  const { resolveBone } = await import('../src/core/anatomy.js');
  const S = await import('../src/core/standard.js');
  const std = S.standardRig();
  for (const rig of [...rigFiles().map((f) => model(f).rig), std]) {
    const f = rig.forwardAxis;
    const fs = rig.forwardSign;
    for (const type of MOTION_TYPES) {
      const c = generateMotion(rig, type);
      const ws = evalWorld(c, c.duration * 0.37, rig);
      for (const p of ws.wp) assert(Number.isFinite(p.x + p.y + p.z), `${type} finite`);
    }
    const walk = generateMotion(rig, 'walk');
    const w0 = evalWorld(walk, 0, rig);
    const fL = w0.wp[rig.byKind.get('foot.L')][f] * fs, fR = w0.wp[rig.byKind.get('foot.R')][f] * fs;
    const hL = w0.wp[rig.byKind.get('hand.L')][f] * fs, hR = w0.wp[rig.byKind.get('hand.R')][f] * fs;
    assert(fL > fR + 0.05 * rig.height, `left foot forward at contact (${(fL - fR).toFixed(3)})`);
    assert(hR > hL, 'opposite arm forward');
    // knee of the swinging leg bends more than the planted one a quarter cycle later
    const run = generateMotion(rig, 'run');
    const r = evalWorld(run, run.duration * 0.25, rig);
    const kneeAngle = (s) => {
      const a = r.wp[rig.byKind.get(`thigh.${s}`)], b = r.wp[rig.byKind.get(`calf.${s}`)], cc = r.wp[rig.byKind.get(`foot.${s}`)];
      return b.clone().sub(a).angleTo(cc.clone().sub(b));
    };
    assert(kneeAngle('L') > kneeAngle('R'), 'swing knee bends');
  }
  assert(resolveBone(std, 'left thigh') === std.byKind.get('thigh.L') && resolveBone(std, 'R Forearm') === std.byKind.get('forearm.R') && resolveBone(std, 'head') === std.special.head, 'bone names resolve');
}
