// Movement modifiers: definitions + a runner with scope selection and live preview.
import { app } from './state.js';
import * as ops from '../core/ops.js';
import { plantFeet, footstepEvents } from '../core/contacts.js';
import { SMOOTH, LINEAR, EASE, STEP } from '../core/channel.js';
import { GROUPS, bonesInSet } from '../core/rig.js';
import { formDialog } from '../ui/dialog.js';
import { toast, h } from '../ui/dom.js';

const frames = (t) => Math.round(t * app.fps);

export const OPS = [
  // ---------------------------------------------------------------- motion
  {
    id: 'amplify',
    group: 'Motion',
    title: 'Exaggerate / calm down',
    desc: 'Scale how far the bones travel. 1.5 = punchier, 0.5 = subtler, 0 = freeze on the pivot pose.',
    fields: [
      { key: 'factor', label: 'Amount', type: 'range', min: 0, max: 3, step: 0.05, value: 1.5, full: true },
      { key: 'pivot', label: 'Scale around', type: 'seg', value: 'mean', options: [{ value: 'mean', label: 'Average pose' }, { value: 'first', label: 'First frame' }, { value: 'rest', label: 'Rest pose' }], full: true },
      { key: 'position', type: 'checkbox', text: 'Include positions (hips bounce / travel)', value: true, full: true },
    ],
    apply: (c, ctx, v) => ops.amplify(c, ctx, { factor: v.factor, pivot: v.pivot, position: v.position, fps: ctx.fps }),
  },
  {
    id: 'smooth',
    group: 'Motion',
    title: 'Smooth',
    desc: 'Soften the motion and remove jitter (Gaussian filter).',
    fields: [{ key: 'radius', label: 'Strength (frames)', type: 'range', min: 1, max: 15, step: 1, value: 3, full: true }],
    apply: (c, ctx, v) => ops.smooth(c, ctx, { radius: v.radius, fps: ctx.fps }),
  },
  {
    id: 'noise',
    group: 'Motion',
    title: 'Add life (noise)',
    desc: 'Organic wobble: breathing, nervousness, hand-held feel. Best on an additive layer or a few bones.',
    fields: [
      { key: 'amount', label: 'Amount (degrees)', type: 'range', min: 0.2, max: 20, step: 0.1, value: 3 },
      { key: 'frequency', label: 'Speed (Hz)', type: 'range', min: 0.1, max: 8, step: 0.1, value: 1.2 },
      { key: 'seed', label: 'Variation', type: 'number', min: 1, max: 999, step: 1, value: 1 },
    ],
    apply: (c, ctx, v) => ops.addNoise(c, ctx, { amount: v.amount, frequency: v.frequency, seed: v.seed | 0, fps: ctx.fps }),
  },
  {
    id: 'offset',
    group: 'Motion',
    title: 'Overlap / delay',
    desc: 'Shift the chosen bones in time so they lag behind (follow-through) or lead the body.',
    defaultBones: 'selected',
    fields: [{ key: 'frames', label: 'Delay (frames, negative = earlier)', type: 'range', min: -20, max: 20, step: 1, value: 3, full: true }],
    apply: (c, ctx, v) => ops.timeOffset(c, ctx, { frames: v.frames, fps: ctx.fps }),
  },
  {
    id: 'loopfix',
    group: 'Motion',
    title: 'Make seamless loop',
    desc: 'Blend the last frames into the first pose so the clip cycles without a pop.',
    noRange: true,
    fields: [{ key: 'frames', label: 'Blend length (frames)', type: 'range', min: 1, max: 30, step: 1, value: 6, full: true }],
    apply: (c, ctx, v) => ops.loopFix(c, { ...ctx, range: null }, { frames: v.frames, fps: ctx.fps }),
  },
  {
    id: 'ease',
    group: 'Motion',
    title: 'Ease timing',
    desc: 'Slow-in / slow-out: re-time the motion with an easing curve (whole body, length unchanged). Great for anticipation and heavy hits.',
    noBones: true,
    fields: [
      { key: 'mode', label: 'Curve', type: 'seg', value: 'inout', full: true, options: [{ value: 'inout', label: 'Ease in & out' }, { value: 'in', label: 'Slow start' }, { value: 'out', label: 'Slow end' }] },
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 1, step: 0.05, value: 0.6, full: true },
    ],
    apply: (c, ctx, v) => ops.easeTiming(c, ctx, { mode: v.mode, strength: v.strength, fps: ctx.fps }),
  },
  // ---------------------------------------------------------------- feet
  {
    id: 'footplant',
    group: 'Feet',
    title: 'Fix foot sliding',
    desc: 'Pin each foot while it stands on the floor, so it stops skating (common after putting a move on another body). Heel-toe roll is kept; walks in place keep moving with the ground.',
    noBones: true,
    noRange: true,
    fields: [
      { key: 'sides', label: 'Feet', type: 'checklist', value: ['L', 'R'], options: [{ value: 'L', label: 'Left foot' }, { value: 'R', label: 'Right foot' }] },
      { key: 'blend', label: 'Ease in / out (frames)', type: 'range', min: 1, max: 8, step: 1, value: 3, full: true },
      { key: 'ground', type: 'checkbox', text: 'Also keep the feet above the floor (no sinking)', value: true, full: true },
    ],
    apply: (c, ctx, v) => plantFeet(c, ctx, { sides: v.sides, blend: v.blend, ground: v.ground, fps: ctx.fps }),
  },
  {
    id: 'footsteps',
    group: 'Feet',
    title: 'Add footstep events',
    desc: 'An event at every moment a foot lands, for footstep sounds and dust in your game. Replaces footstep events made before.',
    noBones: true,
    noRange: true,
    fields: [{ key: 'naming', label: 'Event names', type: 'seg', value: 'side', full: true, options: [{ value: 'side', label: 'footstep_L / footstep_R' }, { value: 'one', label: 'footstep' }] }],
    apply: (c, ctx, v) => {
      const n = footstepEvents(c, ctx.rig, { fps: ctx.fps, name: v.naming === 'one' ? 'footstep' : null });
      return n ? `${n} footstep event${n === 1 ? '' : 's'}` : 'No footsteps found (the feet never land)';
    },
  },
  {
    id: 'findloop',
    group: 'Motion',
    title: 'Find best loop',
    desc: 'For long takes (motion capture): keep the stretch whose end flows back into its start most smoothly, and make it a seamless loop.',
    noBones: true,
    noRange: true,
    fields: [
      { key: 'min', label: 'Shortest loop (s)', type: 'range', min: 0.3, max: 5, step: 0.1, value: 0.6 },
      { key: 'max', label: 'Longest loop (s)', type: 'range', min: 0.5, max: 20, step: 0.1, value: 4 },
      { key: 'inPlace', type: 'checkbox', text: 'In place (take out the travel, so the loop doesn’t jump back)', value: true, full: true },
    ],
    apply: (c, ctx, v) => ops.makeLoop(c, ctx, { min: v.min, max: Math.max(v.min, v.max), inPlace: v.inPlace, fps: ctx.fps }),
  },
  {
    id: 'lockfeet',
    group: 'Feet',
    title: 'Lock feet in place (IK)',
    desc: 'Keep the feet exactly where they are at the start of the range, for standing moves: after you changed the hips or body, the feet stay put.',
    noBones: true,
    fields: [{ key: 'sides', label: 'Feet', type: 'checklist', value: ['L', 'R'], options: [{ value: 'L', label: 'Left foot' }, { value: 'R', label: 'Right foot' }] }],
    apply: (c, ctx, v) => ops.lockFeet(c, ctx, { sides: v.sides, fps: ctx.fps }),
  },
  // ---------------------------------------------------------------- body
  {
    id: 'mirror',
    group: 'Body',
    title: 'Mirror left ↔ right',
    desc: 'Swap the sides of the whole clip — e.g. turn a right-handed attack into a left-handed one.',
    noBones: true,
    noRange: true,
    fields: [],
    apply: (c, ctx) => ops.mirrorClip(c, ctx),
  },
  {
    id: 'rootmotion',
    group: 'Body',
    title: 'Root motion',
    desc: 'Keep the character in place (games usually move the character in code), remove net drift only, or put the travel on the root bone for root motion in the engine.',
    noBones: true,
    noRange: true,
    fields: [
      { key: 'mode', label: 'Mode', type: 'seg', value: 'inplace', options: [{ value: 'inplace', label: 'In place' }, { value: 'drift', label: 'Remove drift only' }, { value: 'root', label: 'On the root bone' }], full: true },
      { key: 'turn', type: 'checkbox', text: 'The root turns with the body too (moves that change direction)', value: false, full: true, show: (v) => v.mode === 'root' },
    ],
    apply: (c, ctx, v) => ops.rootMotion(c, ctx, { mode: v.mode, turn: v.turn, fps: ctx.fps }),
  },
  // ---------------------------------------------------------------- keys
  {
    id: 'resample',
    group: 'Keys',
    title: 'Simplify to N fps',
    desc: 'Replace dense captured keys with evenly spaced ones — much easier to edit by hand.',
    fields: [
      { key: 'fps', label: 'Keys per second', type: 'range', min: 2, max: 30, step: 1, value: 10, full: true },
      { key: 'smooth', type: 'checkbox', text: 'Smooth interpolation between keys', value: true, full: true },
    ],
    apply: (c, ctx, v) => ops.resample(c, ctx, { fps: v.fps, smooth: v.smooth }),
  },
  {
    id: 'reduce',
    group: 'Keys',
    title: 'Reduce keys',
    desc: 'Remove keys that add no visible detail (keeps the motion within the tolerance).',
    fields: [{ key: 'angle', label: 'Tolerance (degrees)', type: 'range', min: 0.05, max: 5, step: 0.05, value: 0.5, full: true }],
    apply: (c, ctx, v) => ops.reduceKeys(c, ctx, { angle: v.angle, distance: app.rig.height * 0.001 * v.angle }),
  },
  {
    id: 'interp',
    group: 'Keys',
    title: 'Set interpolation',
    desc: 'How the motion travels between keys.',
    fields: [
      {
        key: 'mode',
        label: 'Interpolation',
        type: 'seg',
        value: SMOOTH,
        full: true,
        options: [
          { value: SMOOTH, label: 'Smooth' },
          { value: LINEAR, label: 'Linear' },
          { value: EASE, label: 'Ease' },
          { value: STEP, label: 'Step' },
        ],
      },
    ],
    apply: (c, ctx, v) => ops.setInterpolation(c, ctx, { mode: +v.mode }),
  },
  {
    id: 'static',
    group: 'Keys',
    title: 'Clean static channels',
    desc: 'Collapse channels whose keys never change into a single key.',
    fields: [],
    apply: (c, ctx) => ops.removeStatic(c, ctx),
  },
];

const BONE_SCOPES = () => {
  const n = app.sel.bones.size;
  return [
    { value: 'all', label: 'All bones' },
    { value: 'selected', label: `Selected bones (${n})` },
    { value: 'upper', label: 'Upper body' },
    { value: 'lower', label: 'Lower body' },
    { value: 'arms', label: 'Both arms' },
    { value: 'legs', label: 'Both legs' },
    ...GROUPS.filter((g) => g.id !== 'attach').map((g) => ({ value: g.id, label: g.label })),
  ];
};

export function resolveBones(scope) {
  const rig = app.rig;
  if (!scope || scope === 'all') return null;
  if (scope === 'selected') return new Set([...app.sel.bones].map((i) => rig.names[i]));
  return new Set(bonesInSet(rig, scope).map((i) => rig.names[i]));
}

/** Run a modifier with a side dialog and live preview. */
export async function runOp(def) {
  if (!app.clip) return toast('Select a clip first', 'err');
  const fields = [];
  if (!def.noBones) {
    const def0 = def.defaultBones === 'selected' && app.sel.bones.size ? 'selected' : app.sel.bones.size && def.defaultBones !== 'all' ? 'selected' : 'all';
    fields.push({ key: 'bones', label: 'Bones', type: 'select', value: def0, options: BONE_SCOPES() });
  }
  if (!def.noRange) {
    fields.push({
      key: 'range',
      label: 'Time',
      type: 'select',
      value: app.range ? 'range' : 'all',
      options: [{ value: 'all', label: 'Whole clip' }, ...(app.range ? [{ value: 'range', label: `Range ${frames(app.range[0])}–${frames(app.range[1])}` }] : [])],
    });
  }
  fields.push(...def.fields.map((f) => ({ ...f })));
  const L = app.layer;
  const ctxFrom = (v) => ({ rig: app.rig, li: app.layerIndex, fps: app.fps, bones: def.noBones ? null : resolveBones(v.bones), range: v.range === 'range' ? app.range : null });
  let msg;
  app.beginLive(def.title);
  const wasPlaying = app.playing;
  const playBtn = h('button', { class: 'small', title: 'Play the preview', onclick: () => app.setPlaying(!app.playing) }, '▶ Play preview');
  const values = await formDialog({
    title: def.title,
    intro: h('div', { class: 'col', style: { gap: '4px' } }, h('p', {}, def.desc), h('div', { class: 'preview-note' }, `● Live preview · layer “${L.name}”`)),
    fields,
    ok: 'Apply',
    side: true,
    footLeft: playBtn,
    onChange: (v) => app.updateLive((d) => def.apply(d, ctxFrom(v), v)),
  });
  if (!values) {
    app.cancelLive();
    app.setPlaying(wasPlaying);
    return;
  }
  if (values.bones === 'selected' && !app.sel.bones.size) {
    app.cancelLive();
    return toast('No bones selected', 'err');
  }
  app.updateLive((d) => (msg = def.apply(d, ctxFrom(values), values)));
  app.commitLive(def.title);
  app.setPlaying(wasPlaying);
  toast(typeof msg === 'string' ? msg : `${def.title} applied`, 'ok', { action: { label: 'Undo', run: () => app.undo() } });
}
