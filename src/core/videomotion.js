// Video motion capture: body landmarks tracked in a video (MediaPipe Pose, 33 points per frame)
// -> a clip on the AnimStudio standard skeleton, which then retargets to any character.
//
// Landmarks come in two flavours per frame:
//   world: metres, origin between the hips, x = image right, y = down, z = away from camera
//   image: normalised 0..1 image coordinates (used for jumps and travel across the frame)
// The person is assumed to face the camera, so their left is image right and their forward is
// towards the camera. That maps straight onto the standard rig (left = +X, up = +Y, facing +Z).
import * as THREE from 'three';
import { standardRig, averageClips } from './standard.js';
import { makeClip, cloneClip } from './clip.js';
import { evalWorld } from './evaluate.js';
import { trim } from './ops.js';
import { makeChannel, makeQuatsContinuous } from './channel.js';

/** MediaPipe Pose landmark indices ("L" = the person's own left). */
export const LM = {
  nose: 0, earL: 7, earR: 8,
  shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, piL: 17, piR: 18, inL: 19, inR: 20,
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, heL: 29, heR: 30, toL: 31, toR: 32,
};
const COUNT = 33;
// Left/right pairs, for mirrored (selfie) videos.
const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const MIN_VIS = 0.3;

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

/** Rotation taking the canonical axes to (a, b): x = a, z = a × b, y = z × x. */
function basisQ(a, b) {
  const x = a.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, b);
  if (z.lengthSq() < 1e-12) z.crossVectors(x, Math.abs(x.y) < 0.9 ? Y : FWD);
  z.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
/** World rotation that moves the rest frame (d0, s0) onto the measured frame (d, s). */
const frameRot = (d, s, d0, s0) => basisQ(d, s).multiply(basisQ(d0, s0).invert());

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : 0;
};
const percentile = (a, p) => {
  const s = [...a].sort((u, v) => u - v);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))] : 0;
};

/** Fill gaps (low visibility / missing frames) by interpolation; null when never seen. */
function fillSeries(vals, ok) {
  const n = vals.length;
  const good = [];
  for (let f = 0; f < n; f++) if (ok[f]) good.push(f);
  if (!good.length) return null;
  const out = new Array(n);
  let g = 0;
  for (let f = 0; f < n; f++) {
    while (g < good.length - 1 && good[g + 1] <= f) g++;
    const a = good[g];
    if (f <= good[0]) out[f] = vals[good[0]].clone();
    else if (f >= good[good.length - 1]) out[f] = vals[good[good.length - 1]].clone();
    else {
      const b = good[g + 1];
      out[f] = a === f ? vals[f].clone() : vals[a].clone().lerp(vals[b], (f - a) / (b - a));
    }
  }
  return out;
}

/** Gaussian smoothing of a vector series (sigma in frames), optionally weighted by confidence. */
function smoothSeries(s, sigma, conf = null) {
  if (!s || sigma <= 0.05) return s;
  const r = Math.ceil(sigma * 2.5);
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const n = s.length;
  return s.map((_, f) => {
    const acc = new THREE.Vector3();
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = f + k;
      if (j < 0 || j >= n) continue;
      const wk = w[k + r] * (conf ? conf[j] : 1);
      acc.addScaledVector(s[j], wk);
      ws += wk;
    }
    return acc.multiplyScalar(1 / ws);
  });
}

/**
 * Turn tracked landmarks into a clip on the standard rig.
 * @param {{fps:number, width?:number, height?:number, frames:Array<{world?:number[][]|null, image?:number[][]|null}>}} track
 *   each landmark is [x, y, z, visibility?]
 * @param {{mirror?:boolean, inPlace?:boolean, faceForward?:boolean, smooth?:number, name?:string, loop?:boolean}} opts
 * @returns {{clip, info:{frames:number, seen:number, legs:boolean, arms:boolean, jumps:number}}}
 */
export function landmarksToClip(track, { mirror = false, inPlace = true, faceForward = true, smooth = 1.5, name = 'Video motion', loop = false } = {}) {
  const rig = standardRig();
  const fps = track.fps || 30;
  const W = track.width || 1;
  const H = track.height || 1;
  const n = track.frames.length;
  if (n < 2) throw new Error('Need at least two tracked frames.');

  // --- landmark series (rig space), gap-filled and smoothed --------------------------------
  const conv = (lm, j, image) => {
    const src = mirror ? mirrorIndex(j) : j;
    const p = lm?.[src];
    if (!p) return null;
    if (image) return new THREE.Vector3(mirror ? W - p[0] * W : p[0] * W, p[1] * H, 0); // pixels, y down
    return new THREE.Vector3(mirror ? -p[0] : p[0], -p[1], -p[2]);
  };
  // Camera cuts / sudden zooms (common in game footage): the body's size on screen jumps.
  // Those frames are dropped and filled in from their neighbours.
  const frameOk = track.frames.map((fr) => !!fr.world);
  const sizes = track.frames.map((fr) => {
    const p = fr.image;
    if (!p) return 0;
    const mx = (a, b) => [(p[a][0] + p[b][0]) * 0.5 * W, (p[a][1] + p[b][1]) * 0.5 * H];
    const [sx, sy] = mx(LM.shL, LM.shR);
    const [hx, hy] = mx(LM.hipL, LM.hipR);
    return Math.hypot(sx - hx, sy - hy);
  });
  const typical = median(sizes.filter((v) => v > 0));
  if (typical > 0) sizes.forEach((v, f) => v > 0 && (v < typical * 0.6 || v > typical * 1.6) && (frameOk[f] = false));

  const series = (image) => {
    const out = [];
    for (let j = 0; j < COUNT; j++) {
      const vals = [];
      const ok = [];
      const conf = [];
      let visSum = 0;
      let visN = 0;
      track.frames.forEach((fr, f) => {
        const lm = image ? fr.image : fr.world;
        const v = lm && frameOk[f] ? conv(lm, j, image) : null;
        const vis = lm?.[mirror ? mirrorIndex(j) : j]?.[3] ?? 1;
        const good = !!v && vis >= MIN_VIS;
        vals.push(v || new THREE.Vector3());
        ok.push(good);
        // Barely-seen points (hidden behind the body, under clothes) lean on their neighbours.
        conf.push(good ? Math.max(0.05, Math.min(1, vis)) ** 2 : 0.02);
        if (good) (visSum += vis), visN++;
      });
      const meanVis = visN ? visSum / visN : 1;
      out.push(smoothSeries(fillSeries(vals, ok), smooth > 0.05 ? smooth * (1 + 1.5 * (1 - meanVis)) : 0, conf));
    }
    return out;
  };
  const P = series(false);
  const hasImage = track.frames.some((f) => f.image);
  const I = hasImage ? series(true) : null;
  const seenFrac = (j) => {
    let c = 0;
    for (const fr of track.frames) {
      const p = fr.world?.[mirror ? mirrorIndex(j) : j];
      if (p && (p[3] === undefined || p[3] >= MIN_VIS)) c++;
    }
    return c / n;
  };
  for (const j of [LM.shL, LM.shR, LM.hipL, LM.hipR]) if (!P[j]) throw new Error('No body found in the video. Make sure the whole person is visible.');
  const legs = [LM.knL, LM.knR, LM.anL, LM.anR].every((j) => P[j] && seenFrac(j) > 0.4);
  const arms = [LM.elL, LM.elR, LM.wrL, LM.wrR].every((j) => P[j] && seenFrac(j) > 0.3);
  const head = [LM.earL, LM.earR, LM.nose].every((j) => P[j]);

  // --- rest frames of the standard rig ------------------------------------------------------
  const idx = (nm) => rig.names.indexOf(nm);
  const rp = (nm) => rig.restWorld.p[idx(nm)];
  const dir = (a, b) => rp(b).clone().sub(rp(a)).normalize();
  const rest = {};
  for (const s of ['L', 'R']) {
    const back = FWD.clone().negate();
    rest[s] = {
      up: dir(`UpperArm_${s}`, `ForeArm_${s}`),
      fo: dir(`ForeArm_${s}`, `Hand_${s}`),
      ha: dir(`Hand_${s}`, `HandTip_End_${s}`),
      th: dir(`Thigh_${s}`, `Calf_${s}`),
      ca: dir(`Calf_${s}`, `Foot_${s}`),
      ft: dir(`Foot_${s}`, `Toe_End_${s}`),
    };
    const r = rest[s];
    r.elbow = new THREE.Vector3().crossVectors(r.up, FWD).normalize(); // elbow flexion: forearm moves forward
    r.elbowF = new THREE.Vector3().crossVectors(r.fo, FWD).normalize();
    r.knee = new THREE.Vector3().crossVectors(r.th, back).normalize(); // knee flexion: shin moves back
    r.kneeC = new THREE.Vector3().crossVectors(r.ca, back).normalize();
  }
  const HEAD_FWD = new THREE.Vector3(0, -0.3, 1).normalize(); // nose sits a little below the ears

  // --- scale: person -> standard rig --------------------------------------------------------
  const stdLeg = rp('Thigh_L').distanceTo(rp('Calf_L')) + rp('Calf_L').distanceTo(rp('Foot_L'));
  const stdTorso = rp('Hips').distanceTo(rp('Neck'));
  const personLeg = legs ? median(P[LM.hipL].map((_, f) => (P[LM.hipL][f].distanceTo(P[LM.knL][f]) + P[LM.knL][f].distanceTo(P[LM.anL][f]) + P[LM.hipR][f].distanceTo(P[LM.knR][f]) + P[LM.knR][f].distanceTo(P[LM.anR][f])) / 2)) : 0;
  const mid = (a, b, f) => P[a][f].clone().add(P[b][f]).multiplyScalar(0.5);
  const personTorso = median(P[LM.hipL].map((_, f) => mid(LM.hipL, LM.hipR, f).distanceTo(mid(LM.shL, LM.shR, f))));
  const scale = legs && personLeg > 1e-3 ? stdLeg / personLeg : stdTorso / Math.max(personTorso, 1e-3);

  // --- per-frame bone rotations (world) ------------------------------------------------------
  const names = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Clavicle_L', 'Clavicle_R', 'UpperArm_L', 'UpperArm_R', 'ForeArm_L', 'ForeArm_R', 'Hand_L', 'Hand_R', 'Thigh_L', 'Thigh_R', 'Calf_L', 'Calf_R', 'Foot_L', 'Foot_R', 'Toe_L', 'Toe_R'];
  const worldQ = names.map(() => []);
  const W_ = (nm) => names.indexOf(nm);
  const prevHinge = { armL: null, armR: null, legL: null, legR: null };

  /** Hinge axis for a two-bone limb: measured bend plane, or the body's rest hinge when straight. */
  function hinge(key, d1, d2, bodyQ, restAxis) {
    const meas = new THREE.Vector3().crossVectors(d1, d2);
    const sinA = meas.length() / (d1.length() * d2.length() + 1e-9);
    let fb = restAxis.clone().applyQuaternion(bodyQ);
    const u = d1.clone().normalize();
    fb.addScaledVector(u, -fb.dot(u));
    if (fb.lengthSq() < 0.09 && prevHinge[key]) fb = prevHinge[key].clone();
    if (fb.lengthSq() < 1e-6) fb = new THREE.Vector3().crossVectors(u, Math.abs(u.y) < 0.9 ? Y : FWD);
    fb.normalize();
    const w = THREE.MathUtils.smoothstep(sinA, 0.12, 0.35); // ~7°..20° of bend
    const m = sinA > 1e-6 ? meas.normalize() : fb;
    const wk = m.dot(fb) < 0 ? Math.max(0, w * 2 - 1) : w; // a slight "backwards" bend is noise: trust the fallback
    const a = fb.clone().lerp(m, wk);
    a.addScaledVector(u, -a.dot(u));
    if (a.lengthSq() < 1e-8) a.copy(fb);
    a.normalize();
    prevHinge[key] = a.clone();
    return a;
  }

  const yaws = [];
  for (let f = 0; f < n; f++) {
    const p = (j) => P[j][f];
    const torsoUp = mid(LM.shL, LM.shR, f).sub(mid(LM.hipL, LM.hipR, f));
    const qChest = frameRot(p(LM.shL).clone().sub(p(LM.shR)), torsoUp, X, Y);
    // Without legs in view (e.g. a webcam at the desk) keep the pelvis upright; the spine bends.
    const qHips = legs ? frameRot(p(LM.hipL).clone().sub(p(LM.hipR)), torsoUp, X, Y) : new THREE.Quaternion();
    const qSpine = qHips.clone().slerp(qChest, 0.5);
    let qHead = qChest.clone();
    // Seen from behind the face points are guesses (yet reported as visible): the head then
    // follows the chest. Facing the camera or side-on, the face drives it.
    const facing = new THREE.Vector3().crossVectors(p(LM.hipL).clone().sub(p(LM.hipR)), torsoUp).normalize().z; // +1 = towards the camera
    const faceW = THREE.MathUtils.smoothstep(facing, -0.6, -0.1);
    if (head && faceW > 0) {
      const ears = p(LM.earL).clone().add(p(LM.earR)).multiplyScalar(0.5);
      qHead.slerp(frameRot(p(LM.earL).clone().sub(p(LM.earR)), p(LM.nose).clone().sub(ears), X, HEAD_FWD), faceW);
    }
    const qNeck = qChest.clone().slerp(qHead, 0.5);
    const put = (nm, q) => worldQ[W_(nm)].push(q);
    put('Hips', qHips);
    put('Spine', qSpine);
    put('Chest', qChest);
    put('Neck', qNeck);
    put('Head', qHead);
    const fh = new THREE.Vector3(0, 0, 1).applyQuaternion(qHips);
    yaws.push(Math.atan2(fh.x, fh.z));

    for (const s of ['L', 'R']) {
      const r = rest[s];
      put(`Clavicle_${s}`, qChest.clone());
      if (arms) {
        const sh = p(LM[`sh${s}`]), el = p(LM[`el${s}`]), wr = p(LM[`wr${s}`]);
        const dU = el.clone().sub(sh), dF = wr.clone().sub(el);
        const a = hinge(`arm${s}`, dU, dF, qChest, r.elbow);
        const qU = frameRot(dU, a, r.up, r.elbow);
        const qF = frameRot(dF, a, r.fo, r.elbowF);
        let qH = qF.clone();
        if (P[LM[`in${s}`]] && P[LM[`pi${s}`]]) {
          const tip = p(LM[`in${s}`]).clone().add(p(LM[`pi${s}`])).multiplyScalar(0.5);
          const meas = frameRot(tip.sub(wr), p(LM[`in${s}`]).clone().sub(p(LM[`pi${s}`])), r.ha, FWD);
          qH = qF.clone().slerp(meas, 0.6); // pose-model hands are rough: lean on the forearm
        }
        put(`UpperArm_${s}`, qU);
        put(`ForeArm_${s}`, qF);
        put(`Hand_${s}`, qH);
      } else {
        put(`UpperArm_${s}`, qChest.clone());
        put(`ForeArm_${s}`, qChest.clone());
        put(`Hand_${s}`, qChest.clone());
      }
      if (legs) {
        const hp = p(LM[`hip${s}`]), kn = p(LM[`kn${s}`]), an = p(LM[`an${s}`]), to = p(LM[`to${s}`]);
        const dT = kn.clone().sub(hp), dC = an.clone().sub(kn);
        const a = hinge(`leg${s}`, dT, dC, qHips, r.knee);
        const qT = frameRot(dT, a, r.th, r.knee);
        const qC = frameRot(dC, a, r.ca, r.kneeC);
        let qFt = qC.clone();
        if (P[LM[`to${s}`]]) qFt = frameRot(to.clone().sub(an), a, r.ft, new THREE.Vector3().crossVectors(r.ft, FWD.clone().negate()).normalize());
        put(`Thigh_${s}`, qT);
        put(`Calf_${s}`, qC);
        put(`Foot_${s}`, qFt);
        put(`Toe_${s}`, qFt.clone());
      } else {
        put(`Thigh_${s}`, qHips.clone());
        put(`Calf_${s}`, qHips.clone());
        put(`Foot_${s}`, qHips.clone());
        put(`Toe_${s}`, qHips.clone());
      }
    }
  }

  // --- face forward: remove the average body turn (e.g. a walk filmed from the side) --------
  let yawFix = new THREE.Quaternion();
  if (faceForward) {
    const sx = yaws.reduce((a, y) => a + Math.sin(y), 0);
    const cx = yaws.reduce((a, y) => a + Math.cos(y), 0);
    yawFix = new THREE.Quaternion().setFromAxisAngle(Y, -Math.atan2(sx, cx));
    for (const arr of worldQ) for (const q of arr) q.premultiply(yawFix);
  }

  // --- hips translation: grounding + jumps + optional travel ---------------------------------
  const hipOff = Array.from({ length: n }, () => new THREE.Vector3());
  let jumps = 0;
  if (legs) {
    const feet = [LM.anL, LM.anR, LM.heL, LM.heR, LM.toL, LM.toR].filter((j) => P[j]);
    const lowest = (f) => Math.min(...feet.map((j) => P[j][f].y)); // world origin = between the hips
    const hipH = P[LM.hipL].map((_, f) => -lowest(f));
    const stand = percentile(hipH, 0.85);
    for (let f = 0; f < n; f++) hipOff[f].y = (hipH[f] - stand) * scale;
    if (I) {
      // Metres per pixel, from the legs (world length vs image length).
      const mpp = median(P[LM.hipL].map((_, f) => {
        const wl = P[LM.hipL][f].distanceTo(P[LM.anL][f]) + P[LM.hipR][f].distanceTo(P[LM.anR][f]);
        const il = I[LM.hipL][f].distanceTo(I[LM.anL][f]) + I[LM.hipR][f].distanceTo(I[LM.anR][f]);
        return il > 1 ? wl / il : 0;
      }).filter((v) => v > 0));
      const footY = (f) => Math.max(...feet.map((j) => I[j][f].y)); // lowest point on screen
      const floor = percentile(P[LM.hipL].map((_, f) => footY(f)), 0.8);
      let air = false;
      for (let f = 0; f < n; f++) {
        const up = (floor - footY(f)) * mpp; // metres the feet are above the floor line
        const lifted = up > personLeg * 0.06;
        if (lifted && !air) jumps++;
        air = lifted;
        if (lifted) hipOff[f].y += up * scale;
      }
      if (!inPlace) {
        const hx = (f) => (I[LM.hipL][f].x + I[LM.hipR][f].x) / 2;
        const x0 = hx(0);
        for (let f = 0; f < n; f++) hipOff[f].x = (hx(f) - x0) * mpp * scale;
      }
    }
    for (const v of hipOff) v.applyQuaternion(yawFix);
  }

  // --- assemble the clip --------------------------------------------------------------------
  const times = Array.from({ length: n }, (_, f) => f / fps);
  const clip = makeClip(name, (n - 1) / fps);
  clip.loop = !!loop;
  clip.meta = { source: 'video', note: `video capture · ${n} frames${mirror ? ' · mirrored' : ''}` };
  const base = clip.layers[0];
  const tmp = new THREE.Quaternion();
  for (const nm of names) {
    const i = idx(nm);
    const pi = rig.parent[i];
    const pw = pi >= 0 ? names.indexOf(rig.names[pi]) : -1;
    const vals = new Float32Array(n * 4);
    for (let f = 0; f < n; f++) {
      // Standard-rig rest rotations are identity, so local = parentWorld^-1 * world.
      tmp.copy(worldQ[W_(nm)][f]);
      if (pw >= 0) tmp.premultiply(worldQ[pw][f].clone().invert());
      tmp.normalize().toArray(vals, f * 4);
    }
    const ch = makeChannel('rot', times, vals);
    makeQuatsContinuous(ch.values);
    (base.tracks[nm] ||= {}).rot = ch;
  }
  const hips = idx('Hips');
  const pos = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) rig.rest[hips].p.clone().add(hipOff[f]).toArray(pos, f * 3);
  base.tracks.Hips.pos = makeChannel('pos', times, pos);

  return { clip, info: { frames: n, legs, arms, head, jumps, scale } };
}

/**
 * Repeating moves (walk, run, dance…): find the cycle length, cut the capture into cycles and
 * average them into one clean loop. Tracking guesses differ from cycle to cycle, so averaging
 * cancels much of the noise. Returns null when the motion does not repeat clearly.
 * @returns {{clip, period:number, cycles:number}|null}
 */
export function cycleAverage(clip, { fps = 30, minPeriod = 0.35, maxPeriod = 2.5 } = {}) {
  const rig = standardRig();
  const n = Math.round(clip.duration * fps) + 1;
  const pairs = ['L', 'R'].flatMap((s) => [[`UpperArm_${s}`, `ForeArm_${s}`], [`ForeArm_${s}`, `Hand_${s}`], [`Thigh_${s}`, `Calf_${s}`], [`Calf_${s}`, `Foot_${s}`]]).map(([a, b]) => [rig.names.indexOf(a), rig.names.indexOf(b)]);
  const sig = [];
  for (let f = 0; f < n; f++) {
    const w = evalWorld(clip, f / fps, rig);
    sig.push(pairs.map(([a, b]) => w.wp[b].clone().sub(w.wp[a]).normalize()));
  }
  const dist = (f, g) => sig[f].reduce((acc, v, k) => acc + v.distanceToSquared(sig[g][k]), 0);
  const pMin = Math.max(4, Math.round(minPeriod * fps));
  const pMax = Math.min(Math.round(maxPeriod * fps), Math.floor(n / 2));
  if (pMax <= pMin) return null;
  const D = [];
  for (let P = pMin; P <= pMax; P++) {
    let e = 0;
    for (let f = 0; f + P < n; f++) e += dist(f, f + P);
    D[P] = e / (n - P);
  }
  // Typical difference between unrelated frames, to judge whether the motion repeats at all.
  let base = 0;
  let bn = 0;
  for (let f = 0; f < n; f += 3) for (let g = f + 3; g < n; g += 7) (base += dist(f, g)), bn++;
  base /= Math.max(1, bn);
  const vals = D.filter((v) => v !== undefined);
  const best = Math.min(...vals);
  // The first clear dip, not a multiple of it (two cycles also line up). Noisy footage gives
  // shallow dips, so judge the dip by how far it drops below the curve before it.
  let period = 0;
  let peak = -Infinity;
  for (let P = pMin; P <= pMax; P++) {
    peak = Math.max(peak, D[P]);
    const local = D[P - 1] !== undefined && D[P + 1] !== undefined && D[P] <= D[P - 1] && D[P] <= D[P + 1];
    if (local && D[P] <= best + 0.35 * (base - best) && D[P] < base * 0.8 && peak - D[P] > base * 0.15) {
      period = P;
      break;
    }
  }
  if (!period) return null;
  // Sub-frame precision (a 0.65 s cycle is 19.5 frames): parabola through the dip.
  const [a, b, c] = [D[period - 1], D[period], D[period + 1]];
  const den = a - 2 * b + c;
  if (den > 1e-9) period += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  const cycles = Math.floor((n - 1) / period);
  if (cycles < 2) return null;
  const parts = [];
  for (let c = 0; c < cycles; c++) {
    const part = cloneClip(clip, true);
    trim(part, (c * period) / fps, ((c + 1) * period) / fps);
    part.loop = true;
    parts.push(part);
  }
  const out = averageClips(parts, rig, { fps, name: clip.name, loop: true, tolerance: 0 });
  out.meta = { ...clip.meta, note: `${clip.meta?.note || 'video capture'} · ${cycles} cycles averaged` };
  return { clip: out, period: period / fps, cycles };
}

function mirrorIndex(j) {
  for (const [a, b] of PAIRS) {
    if (j === a) return b;
    if (j === b) return a;
  }
  return j;
}
