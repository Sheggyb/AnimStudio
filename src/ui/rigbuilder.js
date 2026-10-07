// Skeleton builder UI: guided joint markers in the viewport, then build bones + skin weights.
import * as THREE from 'three';
import { app } from '../app/state.js';
import { applyRest } from '../core/evaluate.js';
import { makeClip, cloneClip } from '../core/clip.js';
import { MARKERS, markerKeys, autoFind, mirrorMarker, buildSkeleton } from '../io/rigbuild.js';
import { buildModel } from '../io/loader.js';
import { confirmDialog } from './dialog.js';
import { h, clear, toast } from './dom.js';

const LINES = [
  ['pelvis', 'chest'],
  ['chest', 'neck'],
  ['neck', 'headTop'],
  ...['L', 'R'].flatMap((s) => [
    ['neck', `shoulder.${s}`],
    [`shoulder.${s}`, `elbow.${s}`],
    [`elbow.${s}`, `wrist.${s}`],
    [`wrist.${s}`, `handTip.${s}`],
    ['pelvis', `hip.${s}`],
    [`hip.${s}`, `knee.${s}`],
    [`knee.${s}`, `ankle.${s}`],
    [`ankle.${s}`, `toe.${s}`],
  ]),
];

// Reference positions on a 120x200 front-view figure. Character's L is drawn on the right.
const FIG = {
  headTop: [60, 9],
  neck: [60, 42],
  chest: [60, 64],
  pelvis: [60, 102],
  'shoulder.L': [79, 50],
  'elbow.L': [86, 78],
  'wrist.L': [91, 103],
  'handTip.L': [93, 118],
  'hip.L': [69, 104],
  'knee.L': [71, 145],
  'ankle.L': [72, 182],
  'toe.L': [76, 192],
};
for (const k of Object.keys(FIG)) if (k.endsWith('.L')) FIG[k.replace('.L', '.R')] = [120 - FIG[k][0], FIG[k][1]];

function figureSVG(key, partner) {
  const P = (k) => FIG[k];
  const bones = [
    ['neck', 'chest'],
    ['chest', 'pelvis'],
    ...['L', 'R'].flatMap((s) => [
      ['neck', `shoulder.${s}`],
      [`shoulder.${s}`, `elbow.${s}`],
      [`elbow.${s}`, `wrist.${s}`],
      [`wrist.${s}`, `handTip.${s}`],
      ['pelvis', `hip.${s}`],
      [`hip.${s}`, `knee.${s}`],
      [`knee.${s}`, `ankle.${s}`],
      [`ankle.${s}`, `toe.${s}`],
    ]),
  ];
  // Body drawn from the joints themselves, so markers always sit on it.
  const limb = (a, b, w) => `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="#2c3344" stroke-width="${w}" stroke-linecap="round"/>`;
  const sh = (s) => P(`shoulder.${s}`);
  const hp = (s) => P(`hip.${s}`);
  const torsoPts = [sh('R'), sh('L'), [hp('L')[0] + 3, hp('L')[1] + 2], [hp('R')[0] - 3, hp('R')[1] + 2]].map((q) => q.join(',')).join(' ');
  const body =
    `<polygon points="${torsoPts}" fill="#2c3344" stroke="#2c3344" stroke-width="10" stroke-linejoin="round"/>` +
    limb('neck', 'chest', 14) +
    ['L', 'R']
      .map(
        (s) =>
          limb(`shoulder.${s}`, `elbow.${s}`, 9) +
          limb(`elbow.${s}`, `wrist.${s}`, 8) +
          limb(`wrist.${s}`, `handTip.${s}`, 7) +
          limb(`hip.${s}`, `knee.${s}`, 12) +
          limb(`knee.${s}`, `ankle.${s}`, 10) +
          limb(`ankle.${s}`, `toe.${s}`, 7)
      )
      .join('') +
    `<ellipse cx="60" cy="24" rx="12" ry="15" fill="#2c3344"/>`;
  const lines = bones.map(([a, b]) => `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="#4b5568" stroke-width="1.5"/>`).join('');
  const dots = Object.keys(FIG)
    .map((k) => {
      const [x, y] = P(k);
      if (k === key)
        return `<circle cx="${x}" cy="${y}" r="9" fill="#fde04733"><animate attributeName="r" values="6;11;6" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="${x}" cy="${y}" r="4.5" fill="#fde047" stroke="#111" stroke-width="1"/>`;
      if (k === partner) return `<circle cx="${x}" cy="${y}" r="3.5" fill="#fbbf24" opacity=".7"/>`;
      return `<circle cx="${x}" cy="${y}" r="2.2" fill="#60a5fa" opacity=".55"/>`;
    })
    .join('');
  const labels = '<text x="2" y="198" font-size="8" fill="#7a8396">R</text><text x="112" y="198" font-size="8" fill="#7a8396">L</text>';
  return `<svg viewBox="0 0 120 200" width="104" height="173">${body}${lines}${dots}${labels}</svg>`;
}

const info = (key) => {
  const [id, side] = key.split('.');
  const m = MARKERS.find((x) => x.id === id);
  return { ...m, side, title: side ? `${side === 'L' ? 'Left' : 'Right'} ${m.label.toLowerCase()}` : m.label };
};

// Marker -> bone of a skeleton made by Build skeleton (same names every time).
const BONE_OF = { pelvis: 'Hips', chest: 'Chest', neck: 'Neck', headTop: 'HeadTop_End', shoulder: 'UpperArm', elbow: 'ForeArm', wrist: 'Hand', handTip: 'HandTip_End', hip: 'Thigh', knee: 'Calf', ankle: 'Foot', toe: 'Toe' };
const boneFor = (k) => {
  const [id, s] = k.split('.');
  return s ? `${BONE_OF[id]}_${s}` : BONE_OF[id];
};

/** Joint positions of a skeleton this builder made earlier (null for any other rig). */
export function builtMarkers(rig) {
  const out = {};
  for (const k of markerKeys()) {
    const i = rig.byName.get(boneFor(k));
    if (i === undefined) return null;
    out[k] = rig.restWorld.p[i].clone();
  }
  return out;
}

/**
 * Clips after the joints moved: built bones have identity rest rotations, so rotations carry
 * over as they are; absolute positions (hips height…) shift by how far each bone's rest moved.
 */
function shiftClips(clips, oldRig, newRig) {
  const delta = new Map();
  for (let i = 0; i < newRig.bones.length; i++) {
    const j = oldRig.byName.get(newRig.names[i]);
    if (j === undefined) continue;
    const d = newRig.rest[i].p.clone().sub(oldRig.rest[j].p);
    if (d.lengthSq() > 1e-12) delta.set(newRig.names[i], d);
  }
  return clips.map((c) => {
    const nc = cloneClip(c);
    for (const l of nc.layers) {
      if (l.mode === 'additive') continue; // additive positions are offsets already
      for (const [bone, tr] of Object.entries(l.tracks)) {
        const d = delta.get(bone);
        if (!d || !tr.pos) continue;
        const v = tr.pos.values;
        for (let k = 0; k < v.length; k += 3) {
          v[k] += d.x;
          v[k + 1] += d.y;
          v[k + 2] += d.z;
        }
      }
    }
    return nc;
  });
}

export class RigBuilder {
  constructor(viewport) {
    this.vp = viewport;
    this.active = false;
  }

  async open(opts = {}) {
    const model = app.model;
    if (!model) return toast('Open a model first', 'err');
    // A skeleton made here before is edited in place: start from its joints, keep the clips.
    const existing = opts.fresh ? null : builtMarkers(model.rig);
    this.editing = !!existing;
    const hasWork = app.clips.some((c) => c.layers.some((l) => Object.keys(l.tracks).length));
    if (hasWork && !model.synthetic && !opts.skipConfirm && !this.editing) {
      const ok = await confirmDialog(
        'Build a new skeleton?',
        'This replaces the model’s current skeleton with a new humanoid one. Its existing animations will be removed (they belong to the old bones). Afterwards, add moves with ✦ Moves.',
        { ok: 'Continue' }
      );
      if (!ok) return;
    }
    const vp = this.vp;
    this.active = true;
    app.setPlaying(false);
    app.clearBones();
    vp.gizmo.detach();
    applyRest(model.rig);
    model.root.updateMatrixWorld(true);
    vp.builder = this;
    vp.overlay.visible = false;
    vp.trailLine.visible = false;

    const found = autoFind(model.root);
    this.facing = found.facing;
    this.center = found.center;
    this.H = found.height;
    this.pos = {};
    this.state = {};
    for (const k of markerKeys()) {
      this.pos[k] = (existing || found.markers)[k].clone();
      this.state[k] = existing ? 'placed' : 'auto';
    }
    this.symmetry = true;
    this.current = 'pelvis';
    this.ground = found.ground;
    this.fit = this.fitFromMarkers(existing || found.markers, found);
    this.mode = existing ? 'tune' : 'fit';
    if (!existing) this.applyFit();
    this.buildVisuals();
    this.buildPanel();
    this.setMode(this.mode);
    const dom = vp.renderer.domElement;
    this.handlers = {
      pointerdown: (e) => this.onPointerDown(e),
      pointermove: (e) => this.onPointerMove(e),
      pointerup: (e) => this.onPointerUp(e),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) dom.addEventListener(ev, fn, true);
    dom.style.cursor = 'crosshair';
    vp.frameModel('front', 310);
    this.select('pelvis');
  }

  // ------------------------------------------------------------------ reference skeleton
  /** Template joint positions for the current fit (size, widths, arm angle, leg length, offset). */
  templateMarkers(f) {
    const u = f.size / 183; // figure units -> model units
    const side = this.facing || 1; // character's left is +X when facing +Z
    const out = {};
    const pelvisY = f.y + (192 - FIG.pelvis[1]) * u * f.legs;
    // upper body: offsets from the pelvis scaled by the body-length factor
    const upY = (fy) => pelvisY + (FIG.pelvis[1] - fy) * u * f.torso;
    for (const k of ['headTop', 'neck', 'chest', 'pelvis']) out[k] = new THREE.Vector3(f.x, upY(FIG[k][1]), f.z);
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? 1 : -1;
      // legs: widths from the hips, heights stretched by the leg factor
      for (const k of ['hip', 'knee', 'ankle', 'toe']) {
        const [fx, fy] = FIG[`${k}.L`];
        const p = new THREE.Vector3(f.x + (fx - 60) * u * f.hips * sg * side, f.y + (192 - fy) * u * f.legs, f.z);
        if (k === 'toe') p.z += 10 * u * (this.facing || 1);
        out[`${k}.${s}`] = p;
      }
      // arms: shoulder from the shoulder width, then a chain at the chosen angle
      const [sx, sy] = FIG['shoulder.L'];
      const shoulder = new THREE.Vector3(f.x + (sx - 60) * u * f.shoulders * sg * side, upY(sy), f.z);
      const a = (f.arms * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(a) * sg * side, -Math.cos(a), 0);
      const len = (k1, k2) => Math.hypot(FIG[k2][0] - FIG[k1][0], FIG[k2][1] - FIG[k1][1]) * u * f.armLen;
      out[`shoulder.${s}`] = shoulder;
      out[`elbow.${s}`] = shoulder.clone().addScaledVector(dir, len('shoulder.L', 'elbow.L'));
      out[`wrist.${s}`] = out[`elbow.${s}`].clone().addScaledVector(dir, len('elbow.L', 'wrist.L'));
      out[`handTip.${s}`] = out[`wrist.${s}`].clone().addScaledVector(dir, len('wrist.L', 'handTip.L'));
    }
    return out;
  }

  /** Initial fit derived from auto-find so the reference starts close. */
  fitFromMarkers(m, found) {
    const size = found.height;
    const u = size / 183;
    const cx = found.center;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : 1));
    const sh = Math.abs(m['shoulder.L'].x - cx) / ((FIG['shoulder.L'][0] - 60) * u);
    const hp = Math.abs(m['hip.L'].x - cx) / ((FIG['hip.L'][0] - 60) * u);
    const arm = m['wrist.L'].clone().sub(m['shoulder.L']);
    const arms = (Math.atan2(Math.abs(arm.x), -arm.y) * 180) / Math.PI;
    const legs = (m.pelvis.y - found.ground) / ((192 - FIG.pelvis[1]) * u);
    const torso = (found.ground + found.height - m.pelvis.y) / ((FIG.pelvis[1] - FIG.headTop[1]) * u);
    const armLen = arm.length() / (Math.hypot(FIG['wrist.L'][0] - FIG['shoulder.L'][0], FIG['wrist.L'][1] - FIG['shoulder.L'][1]) * u);
    return {
      x: cx,
      y: found.ground,
      z: m.pelvis.z,
      size,
      shoulders: clamp(sh, 0.5, 3),
      hips: clamp(hp, 0.5, 3.5),
      arms: clamp(arms, 0, 110),
      legs: clamp(legs, 0.4, 2),
      torso: clamp(torso, 0.5, 2.2),
      armLen: clamp(armLen, 0.5, 2),
    };
  }

  applyFit() {
    const t = this.templateMarkers(this.fit);
    for (const k of markerKeys()) {
      if (!this.pos[k]) this.pos[k] = new THREE.Vector3();
      this.pos[k].copy(t[k]);
      this.state[k] = 'auto';
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.fitBox) return;
    this.fitBox.classList.toggle('hidden', mode !== 'fit');
    this.tuneBox.classList.toggle('hidden', mode !== 'tune');
    this.tabFit.classList.toggle('on', mode === 'fit');
    this.tabTune.classList.toggle('on', mode === 'tune');
    if (mode === 'fit') this.current = null;
    else if (!this.current) this.current = 'pelvis';
    this.refresh();
    this.updateFigure();
  }

  // ------------------------------------------------------------------ visuals
  buildVisuals() {
    const scene = this.vp.scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const geo = new THREE.SphereGeometry(this.H * 0.016, 16, 12);
    this.meshes = {};
    for (const k of markerKeys()) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#60a5fa', depthTest: false, transparent: true }));
      m.renderOrder = 1002;
      this.group.add(m);
      this.meshes[k] = m;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINES.length * 6), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#fde047', depthTest: false, transparent: true, opacity: 0.85 }));
    this.lines.renderOrder = 1001;
    this.group.add(this.lines);
    this.refresh();
  }

  refresh() {
    for (const k of markerKeys()) {
      const m = this.meshes[k];
      m.position.copy(this.pos[k]);
      const fitMode = this.mode === 'fit';
      const cur = !fitMode && k === this.current;
      const partner = !fitMode && this.symmetry && k === this.partnerOf(this.current);
      m.material.color.set(cur ? '#fde047' : partner ? '#fbbf24' : this.state[k] === 'placed' ? '#4ade80' : '#60a5fa');
      m.material.opacity = fitMode ? 0.95 : cur ? 1 : partner ? 0.55 : 0.28;
      m.scale.setScalar(fitMode ? 1 : cur ? 2.1 : partner ? 1.2 : 0.7);
      if (fitMode) m.material.color.set('#f472b6');
    }
    const pos = this.lines.geometry.attributes.position;
    LINES.forEach(([a, b], i) => {
      pos.setXYZ(i * 2, this.pos[a].x, this.pos[a].y, this.pos[a].z);
      pos.setXYZ(i * 2 + 1, this.pos[b].x, this.pos[b].y, this.pos[b].z);
    });
    pos.needsUpdate = true;
    this.lines.material.opacity = this.mode === 'fit' ? 0.9 : 0.35;
    this.lines.material.color.set(this.mode === 'fit' ? '#f472b6' : '#fde047');
    this.renderList();
  }

  // ------------------------------------------------------------------ panel
  buildPanel() {
    this.list = h('div', { class: 'col rb-list', style: { gap: '1px' } });
    this.hint = h('div', { class: 'rb-hint' });
    this.panel = h(
      'div',
      { class: 'rb-panel card' },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, this.editing ? 'Edit skeleton' : 'Build skeleton'), h('button', { class: 'ghost icon', title: 'Cancel', onclick: () => this.close() }, '✕')),
      this.editing
        ? h('div', { class: 'rb-hint' }, 'Move any joint: pick it in the list (or click its dot), then click the model where it should be, or drag the yellow dot. Press Update skeleton — your animations are kept.')
        : null,
      h('div', { class: 'seg', style: { width: '100%' } }, (this.tabFit = h('button', { style: { flex: 1 }, onclick: () => this.setMode('fit') }, '1 · Fit reference')), (this.tabTune = h('button', { style: { flex: 1 }, onclick: () => this.setMode('tune') }, '2 · Fine-tune joints'))),
      h('div', { class: 'row wrap' }, h('button', { class: 'small', onclick: () => this.vp.frameModel('front', 310) }, 'Front view'), h('button', { class: 'small', onclick: () => this.vp.frameModel('left', 310) }, 'Side view'), h('button', { class: 'small', title: 'Let AnimStudio guess the fit again from the mesh', onclick: () => this.autoAgain() }, '↻ Auto-fit')),
      h(
        'div',
        { class: 'rb-body' },
      (this.fitBox = this.buildFitBox()),
      (this.tuneBox = h(
        'div',
        { class: 'col', style: { gap: '8px', minHeight: 0 } },
        h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: 1.45 } }, 'Optional: correct single joints. Pick one, then click the model where it is or drag the big yellow dot.'),
        (this.figure = h('div', { class: 'rb-figure' })),
        this.hint,
        h('label', { class: 'check', style: { fontSize: '12px' } }, h('input', { type: 'checkbox', checked: true, onchange: (e) => ((this.symmetry = e.target.checked), this.refresh()) }), 'Mirror left → right'),
        this.list
      ))
      ),
      h(
        'label',
        { class: 'check', style: { fontSize: '12px' }, title: 'Everything above the neck follows the Head bone only, so the head turns and nods without stretching. Untick for soft heads (faces that should squash).' },
        h('input', { type: 'checkbox', checked: this.rigidHead !== false, onchange: (e) => (this.rigidHead = e.target.checked) }),
        'Head moves as one piece (no stretching)'
      ),
      h('div', { class: 'row' }, h('button', { class: 'grow', onclick: () => this.close() }, 'Cancel'), h('button', { class: 'primary grow', onclick: () => this.build() }, this.editing ? 'Update skeleton' : 'Build skeleton'))
    );
    document.getElementById('center').append(this.panel);
  }

  buildFitBox() {
    const f = this.fit;
    const base = { ...f };
    this.sliders = {};
    const row = (key, label, min, max, step, fmt) => {
      const val = h('span', { class: 'mono muted', style: { width: '44px', textAlign: 'right', fontSize: '11.5px' } });
      const rng = h('input', {
        type: 'range',
        min,
        max,
        step,
        value: f[key],
        oninput: (e) => {
          f[key] = +e.target.value;
          val.textContent = fmt(f[key]);
          this.applyFit();
          this.refresh();
        },
      });
      val.textContent = fmt(f[key]);
      this.sliders[key] = { rng, val, fmt };
      return h('div', { class: 'rb-slider' }, h('span', {}, label), rng, val);
    };
    const pct = (v) => `${Math.round(v * 100)}%`;
    return h(
      'div',
      { class: 'col', style: { gap: '7px' } },
      h('div', { class: 'rb-hint' }, 'Drag a pink dot to move the skeleton; use the sliders to match the body.'),
      row('size', 'Height', base.size * 0.5, base.size * 1.5, base.size / 500, (v) => v.toFixed(2)),
      row('legs', 'Leg length', 0.4, 2, 0.01, pct),
      row('torso', 'Body length', 0.5, 2.2, 0.01, pct),
      row('shoulders', 'Shoulder width', 0.5, 3, 0.01, pct),
      row('hips', 'Hip width', 0.5, 3.5, 0.01, pct),
      row('arms', 'Arms down ↔ out', 0, 110, 1, (v) => `${Math.round(v)}°`),
      row('armLen', 'Arm length', 0.5, 2, 0.01, pct),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'When it lines up, press Build skeleton — or go to step 2 to correct single joints first.')
    );
  }

  syncSliders() {
    for (const [k, s] of Object.entries(this.sliders || {})) {
      s.rng.value = this.fit[k];
      s.val.textContent = s.fmt(this.fit[k]);
    }
  }

  renderList() {
    if (!this.list) return;
    clear(this.list);
    for (const k of markerKeys()) {
      if (this.symmetry && k.endsWith('.R')) continue;
      const inf = info(k);
      const st = this.state[k];
      this.list.append(
        h(
          'div',
          { class: 'rb-row' + (k === this.current ? ' on' : ''), onclick: () => (this.mode === 'tune' ? this.select(k) : (this.setMode('tune'), this.select(k))), title: inf.hint },
          h('span', { class: 'swatch', style: { background: k === this.current ? '#fde047' : st === 'placed' ? '#4ade80' : '#60a5fa' } }),
          h('span', { class: 'grow' }, this.symmetry && inf.side ? inf.label : inf.title),
          h('span', { class: 'muted', style: { fontSize: '11px' } }, st === 'placed' ? 'set' : 'auto')
        )
      );
    }
    if (!this.current) return;
    const inf = info(this.current);
    if (this.hint) this.hint.textContent = `${inf.hint}. Click the model there — or drag the big yellow dot.`;
  }

  partnerOf(k) {
    return k?.endsWith('.L') ? k.replace('.L', '.R') : k?.endsWith('.R') ? k.replace('.R', '.L') : null;
  }

  select(k) {
    this.current = k;
    this.vp.gizmo.detach();
    this.refresh();
    this.updateFigure();
  }

  screenOf(k) {
    const vp = this.vp;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const v = this.pos[k].clone().applyMatrix4(app.model.root.matrixWorld).project(vp.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  // Drag the selected (yellow) marker in the screen plane.
  nearestMarker(e, maxPx = 16) {
    let best = null,
      bd = maxPx;
    for (const k of markerKeys()) {
      const s = this.screenOf(k);
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      if (d < bd) [bd, best] = [d, k];
    }
    return best;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    let grab = this.current;
    if (this.mode === 'fit') {
      grab = this.nearestMarker(e);
      if (!grab) return;
    } else {
      const s = this.screenOf(this.current);
      if (Math.hypot(s.x - e.clientX, s.y - e.clientY) > 16) return;
    }
    this.grab = grab;
    e.stopImmediatePropagation();
    e.preventDefault();
    const vp = this.vp;
    vp.orbit.enabled = false;
    vp.down = null;
    const world = this.pos[grab].clone().applyMatrix4(app.model.root.matrixWorld);
    this.dragStart = { hit: this.pos[grab].clone(), fit: { ...this.fit } };
    const normal = new THREE.Vector3();
    vp.camera.getWorldDirection(normal);
    this.dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
    vp.renderer.domElement.setPointerCapture(e.pointerId);
    vp.renderer.domElement.style.cursor = 'grabbing';
  }

  onPointerMove(e) {
    const vp = this.vp;
    if (!this.dragPlane) {
      let over;
      if (this.mode === 'fit') over = !!this.nearestMarker(e);
      else {
        const s = this.screenOf(this.current);
        over = Math.hypot(s.x - e.clientX, s.y - e.clientY) <= 16;
      }
      vp.renderer.domElement.style.cursor = over ? 'grab' : this.mode === 'fit' ? '' : 'crosshair';
      return;
    }
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), vp.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this.dragPlane, hit)) return;
    hit.applyMatrix4(app.model.root.matrixWorld.clone().invert());
    if (this.mode === 'fit') {
      const d = hit.sub(this.dragStart.hit);
      Object.assign(this.fit, { x: this.dragStart.fit.x + d.x, y: this.dragStart.fit.y + d.y, z: this.dragStart.fit.z + d.z });
      this.applyFit();
    } else this.set(this.current, hit);
    this.refresh();
  }

  onPointerUp() {
    if (!this.dragPlane) return;
    this.dragPlane = null;
    this.vp.orbit.enabled = true;
    this.vp.down = null;
    this.vp.renderer.domElement.style.cursor = 'crosshair';
  }

  next() {
    const keys = markerKeys().filter((k) => !(this.symmetry && k.endsWith('.R')));
    const i = keys.indexOf(this.current);
    const rest = [...keys.slice(i + 1), ...keys.slice(0, i)];
    const k = rest.find((x) => this.state[x] !== 'placed') || keys[(i + 1) % keys.length];
    this.select(k);
  }

  set(k, p, state = 'placed') {
    this.pos[k].copy(p);
    this.state[k] = state;
    if (this.symmetry && k.endsWith('.L')) {
      const r = k.replace('.L', '.R');
      this.pos[r].copy(mirrorMarker(p, this.pos.pelvis.x));
      this.state[r] = state;
    }
    if (this.symmetry && k === 'pelvis') {
      // keep pairs symmetric around the new centre
      for (const key of markerKeys()) if (key.endsWith('.L')) this.pos[key.replace('.L', '.R')].copy(mirrorMarker(this.pos[key], p.x));
    }
  }

  updateFigure() {
    if (!this.figure || !this.current) return;
    const k = this.current;
    const inf = info(k);
    const mirrorToo = this.symmetry && inf.side;
    this.figure.innerHTML = figureSVG(k, mirrorToo ? this.partnerOf(k) : null);
    const side = inf.side === 'L' ? ['left', 'right'] : ['right', 'left'];
    this.figure.append(
      h(
        'div',
        { class: 'rb-figure-txt' },
        h('b', {}, inf.title),
        inf.side ? h('div', { class: 'muted' }, `Character's ${side[0]} = your ${side[1]} when it faces you.${mirrorToo ? ' The other side follows.' : ''}`) : null
      )
    );
  }

  autoAgain() {
    const found = autoFind(app.model.root);
    this.fit = this.fitFromMarkers(found.markers, found);
    this.applyFit();
    this.panel?.remove();
    this.buildPanel();
    this.setMode('fit');
  }

  // ------------------------------------------------------------------ input
  onClick(e) {
    if (this.mode === 'fit') return;
    const vp = this.vp;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    // Clicking near a marker selects it.
    let best = null,
      bd = 12;
    const v = new THREE.Vector3();
    for (const k of markerKeys()) {
      if (this.symmetry && k.endsWith('.R')) continue;
      v.copy(this.pos[k]).project(vp.camera);
      const d = Math.hypot(rect.left + ((v.x + 1) / 2) * rect.width - e.clientX, rect.top + ((1 - v.y) / 2) * rect.height - e.clientY);
      if (d < bd) [bd, best] = [d, k];
    }
    if (best) return this.select(best);
    // Otherwise place the current marker inside the body under the cursor.
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, vp.camera);
    const hits = ray.intersectObjects(app.model.meshes.filter((m) => m.visible), false);
    if (!hits.length) return;
    const first = hits[0];
    const back = hits.find((x) => x.distance > first.distance + this.H * 0.002 && x.distance - first.distance < this.H * 0.35);
    const inv = app.model.root.matrixWorld.clone().invert();
    const p = back ? first.point.clone().lerp(back.point, 0.5) : first.point.clone().addScaledVector(ray.ray.direction, this.H * 0.02);
    p.applyMatrix4(inv);
    this.set(this.current, p);
    this.refresh();
    this.next();
  }

  onGizmo(phase) {
    if (phase === 'move' || phase === 'end') {
      const k = this.current;
      this.set(k, this.meshes[k].position.clone());
      this.refresh();
    }
  }

  // ------------------------------------------------------------------ finish
  cleanup() {
    const vp = this.vp;
    vp.gizmo.detach();
    const dom = vp.renderer.domElement;
    for (const [ev, fn] of Object.entries(this.handlers || {})) dom.removeEventListener(ev, fn, true);
    dom.style.cursor = '';
    vp.orbit.enabled = true;
    if (this.group) {
      vp.scene.remove(this.group);
      this.group.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()));
    }
    this.panel?.remove();
    this.panel = this.list = this.hint = null;
    vp.builder = null;
    vp.overlay.visible = true;
    this.active = false;
  }

  close() {
    this.cleanup();
    this.vp.needsEval = true;
  }

  build() {
    const model = app.model;
    const markers = {};
    for (const k of markerKeys()) markers[k] = this.pos[k].clone();
    this.cleanup();
    try {
      const oldRig = model.rig;
      const r = buildSkeleton(model.gltf, markers, { facing: this.facing, rigidHead: this.rigidHead !== false });
      const rebuilt = buildModel(model.gltf, model.name, model.url);
      if (this.editing) {
        // Same bones, new places: keep every clip (and the props on the sockets).
        const clips = shiftClips(app.clips, oldRig, rebuilt.rig);
        app.replaceModel(rebuilt);
        app.editClips('Edit skeleton', () => clips);
        import('../app/session.js').then((m) => m.saveRiggedModel()).catch((e) => toast('Could not save the rigged model: ' + e.message, 'err'));
        toast('Skeleton updated — your animations are kept. Play a clip to check it.', 'ok', { ms: 6000 });
        return;
      }
      const clip = makeClip('Animation 1', 2);
      clip.meta = { source: 'new', note: 'starter clip' };
      app.setModel(rebuilt, [clip]);
      app.markDirty();
      // Keep the rig: save mesh + skeleton + sockets to AnimStudio/models (it would be lost on reload).
      import('../app/session.js').then((m) => m.saveRiggedModel()).catch((e) => toast('Could not save the rigged model: ' + e.message, 'err'));
      toast(`Skeleton built: ${r.bones} bones${rebuilt.rig.humanoid ? ' · humanoid ✓' : ''}. Turn on “Weights” and click bones to check the skinning.`, 'ok', {
        ms: 12000,
        action: { label: 'Make moves…', run: () => import('../app/commands.js').then((c) => c.run('tools.moveMaker')) },
      });
    } catch (e) {
      console.error(e);
      toast('Could not build the skeleton: ' + e.message, 'err');
      this.vp.needsEval = true;
    }
  }
}
