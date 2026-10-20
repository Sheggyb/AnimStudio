// Ready-made weapon animations: hold, aim, fire (throw for grenades), on a breathing idle body,
// and "hold it in this clip" (the weapon held steady over a walk or run). The arms come from
// weapon-driven IK (weaponik.js): the weapon is placed, the hands go onto it.
import { app } from './state.js';
import { generateMotion } from '../core/gait.js';
import { makeLayer } from '../core/clip.js';
import { trim } from '../core/ops.js';
import { keyWeaponPoses, heldProp } from './weaponik.js';

/**
 * Poses for a right-handed weapon, in metres from the chest as [left, up, forward] (for an arm
 * 0.55 m long; scaled to the character). Two-handed weapons give both palms ({ main, support }):
 * the weapon runs from one to the other, and both are points the arms can reach.
 * One-handed ones give the grip and aim [yaw° (+ left), pitch° (+ up)].
 */
const HOLD = {
  rifle: { main: [-0.14, -0.06, 0.17], support: [0.02, -0.2, 0.32] },
  bazooka: { main: [-0.14, -0.1, 0.14], support: [-0.02, -0.2, 0.34] },
  pistol: { grip: [-0.16, -0.42, 0.12], aim: [0, -65], oneHand: true },
  grenade: { grip: [-0.17, -0.4, 0.1], aim: [0, -60], oneHand: true },
};
const AIM = {
  rifle: { main: [-0.1, 0.12, 0.22], support: [-0.09, 0.12, 0.46] },
  bazooka: { main: [-0.12, 0.06, 0.12], support: [-0.12, 0.06, 0.36] },
  pistol: { grip: [-0.04, 0.16, 0.45], aim: [0, 0] },
};
const KICK = { rifle: { back: 0.03, up: 5 }, bazooka: { back: 0.06, up: 9 }, pistol: { back: 0.03, up: 14 } };

/** Which built-in behaviour a prop gets (files: two-handed when they have a support grip). */
export function weaponKind(p, hasSupport) {
  const b = p.source.startsWith('builtin:') ? p.source.slice(8) : null;
  if (b && (HOLD[b] || b === 'grenade')) return b;
  return hasSupport ? 'rifle' : 'pistol';
}

/** The animations a weapon offers: [{ id, label, title }]. */
export function weaponActions(kind) {
  if (kind === 'grenade') return [
    { id: 'hold', label: 'Hold', title: 'Standing, grenade in hand (loops)' },
    { id: 'throw', label: 'Throw', title: 'Wind up and throw' },
  ];
  return [
    { id: 'hold', label: 'Hold', title: 'Standing, weapon held low (loops)' },
    { id: 'aim', label: 'Aim', title: 'Standing, aiming forward (loops)' },
    { id: 'fire', label: 'Fire', title: 'Aiming with recoil, loops as automatic fire' },
  ];
}

const flipX = (v, m) => v && [v[0] * m, v[1], v[2]];
const mirror = (ps, m) => ({ ...ps, grip: flipX(ps.grip, m), main: flipX(ps.main, m), support: flipX(ps.support, m), aim: ps.aim && [ps.aim[0] * m, ps.aim[1]] });

function armScale(rig) {
  const ik = rig.ik['hand.R'] || rig.ik['hand.L'];
  const P = rig.restWorld.p;
  const len = P[ik.upper].distanceTo(P[ik.lower]) + P[ik.lower].distanceTo(P[ik.end]);
  return Math.min(1.6, Math.max(0.35, len / 0.55));
}
const mul = (v, s) => v && v.map((x) => x * s);
const scaled = (ps, s) => ({ ...ps, grip: mul(ps.grip, s), main: mul(ps.main, s), support: mul(ps.support, s) });

/** The pose pushed back and tipped up by the shot. f = 1 full kick. */
function kicked(a, k, f) {
  if (a.main) {
    const len = Math.hypot(...a.support.map((v, i) => v - a.main[i]));
    const rise = Math.sin(k.up * f * (Math.PI / 180)) * len;
    return { main: [a.main[0], a.main[1], a.main[2] - k.back * f], support: [a.support[0], a.support[1] + rise, a.support[2] - k.back * f] };
  }
  return { grip: [a.grip[0], a.grip[1] + 0.01 * f, a.grip[2] - k.back * f], aim: [a.aim[0], a.aim[1] + k.up * f] };
}

/** Poses (frames at 30 fps) for one action, for a right-handed hold. */
function actionPoses(kind, action, frames) {
  const every = (pose, step = 8) => {
    const out = [];
    for (let f = 0; f < frames; f += step) out.push({ ...pose, frame: f });
    out.push({ ...pose, frame: frames });
    return out;
  };
  if (action === 'hold') return every(HOLD[kind]);
  if (action === 'aim') return every(AIM[kind]);
  if (action === 'fire') {
    const a = AIM[kind],
      k = KICK[kind];
    return [
      { ...a, frame: 0 },
      { ...kicked(a, k, 1), frame: 2 },
      { ...kicked(a, k, 0.25), frame: 4 },
      { ...a, frame: frames },
    ];
  }
  if (action === 'throw') {
    return [
      { grip: [-0.17, -0.4, 0.1], aim: [0, -60], frame: 0 },
      { grip: [-0.22, 0.22, -0.22], aim: [0, 70], elbow: 'out', frame: 12 },
      { grip: [-0.12, 0.25, 0.3], aim: [0, 25], frame: 17 },
      { grip: [0.02, -0.2, 0.32], aim: [20, -40], frame: 24 },
      { grip: [-0.17, -0.4, 0.1], aim: [0, -60], frame: 40 },
    ];
  }
  throw new Error(`Unknown weapon action "${action}"`);
}

const LENGTH = { hold: 96, aim: 96, fire: 8, throw: 40 };

function armMask(rig) {
  const bones = [];
  for (const s of ['L', 'R']) {
    const ik = rig.ik[`hand.${s}`];
    if (ik) bones.push(ik.upper, ik.lower, ik.end);
  }
  return bones.map((i) => rig.names[i]);
}

/** Key the weapon pose on an arms-only "Weapon" layer of `clip` (replacing an older one). */
async function keyOnLayer(clip, poses, { propView, held, oneHand }) {
  const rig = app.rig;
  app.edit(
    'Weapon layer',
    (d) => {
      d.layers = d.layers.filter((l) => l.name !== 'Weapon');
      const L = makeLayer('Weapon', 'override');
      L.mask = armMask(rig);
      d.layers.push(L);
    },
    { clipId: clip.id }
  );
  const c = app.clips.find((x) => x.id === clip.id);
  const r = await keyWeaponPoses(c, poses, { propView, prop: held.p.id, support: !oneHand && !!held.support, layer: 'Weapon' });
  const L = app.clips.find((x) => x.id === clip.id).layers.find((l) => l.name === 'Weapon');
  if (L) app.setLayer(L.id);
  return r;
}

/**
 * Make a new clip with the held weapon: action 'hold' | 'aim' | 'fire' | 'throw'.
 * Returns { clip, out_of_reach }.
 */
export async function makeWeaponClip(action, { propView, prop = null } = {}) {
  const rig = app.rig;
  if (!rig?.humanoid) throw new Error('Weapon animations need a humanoid skeleton (Tools › Build skeleton).');
  const held = await heldProp(propView, prop);
  if (/back/i.test(held.p.socket)) throw new Error(`${held.p.name} is on the back. Put it in a hand first.`);
  const kind = weaponKind(held.p, !!held.support);
  const ok = weaponActions(kind).map((a) => a.id);
  if (!ok.includes(action)) throw new Error(`${held.p.name} can't "${action}". It can: ${ok.join(', ')}.`);
  const m = held.p.socket === 'Weapon_L' ||rig.kind[rig.byName.get(held.p.socket)] === 'hand.L' ? -1 : 1;
  const frames = LENGTH[action];
  const s = armScale(rig);
  const poses = actionPoses(kind, action, frames).map((ps) => mirror(scaled(ps, s), m));
  const name = `${held.p.name}_${action[0].toUpperCase()}${action.slice(1)}`;
  const clip = generateMotion(rig, 'idle', { name, cycles: 1 });
  if (frames / app.fps < clip.duration) trim(clip, 0, frames / app.fps);
  clip.loop = action !== 'throw';
  clip.meta = { source: 'new', note: `${held.p.name}: ${action}` };
  app.addClip(clip, `Weapon ${action}`);
  const oneHand = action === 'throw' || (action === 'hold' && HOLD[kind]?.oneHand) || kind === 'grenade';
  const r = await keyOnLayer(clip, poses, { propView, held, oneHand });
  return { clip: app.clips.find((x) => x.id === clip.id), out_of_reach: r.out_of_reach };
}

/** Hold the weapon (held low, or aimed) through the current clip: a walk or run with a rifle. */
export async function holdInClip(clip, { propView, prop = null, aim = false } = {}) {
  const rig = app.rig;
  if (!rig?.humanoid) throw new Error('Needs a humanoid skeleton.');
  const held = await heldProp(propView, prop);
  if (/back/i.test(held.p.socket)) throw new Error(`${held.p.name} is on the back. Put it in a hand first.`);
  const kind = weaponKind(held.p, !!held.support);
  const m = held.p.socket === 'Weapon_L' ? -1 : 1;
  const base = aim && AIM[kind] ? AIM[kind] : HOLD[kind];
  const frames = Math.max(1, Math.round(clip.duration * app.fps));
  const poses = [];
  for (let f = 0; f < frames; f += 3) poses.push({ ...mirror(scaled(base, armScale(rig)), m), frame: f });
  poses.push({ ...mirror(scaled(base, armScale(rig)), m), frame: frames });
  const r = await keyOnLayer(clip, poses, { propView, held, oneHand: !!base.oneHand || kind === 'grenade' });
  return { clip: app.clips.find((x) => x.id === clip.id), out_of_reach: r.out_of_reach };
}
