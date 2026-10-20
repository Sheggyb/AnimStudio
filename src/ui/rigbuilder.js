// Skeleton builder UI: joint markers in the viewport (found automatically, dragged into place),
// then build bones + skin weights. Optional fingers.
import * as THREE from 'three';
import { app } from '../app/state.js';
import { applyRest } from '../core/evaluate.js';
import { makeClip, cloneClip } from '../core/clip.js';
import { markerKeys, markerInfo, fingerBones, autoFind, findFingers, FINGERS, mirrorMarker, buildSkeleton, collectVertices } from '../io/rigbuild.js';
import { buildModel } from '../io/loader.js';
import { confirmDialog } from './dialog.js';
import { h, clear, toast } from './dom.js';

const BODY_LINES = [
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
const FINGER_LINES = ['L', 'R'].flatMap((s) => FINGERS.flatMap((f) => [[`wrist.${s}`, `${f}.${s}`], [`${f}.${s}`, `${f}Tip.${s}`]]));

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
  const limb = (a, b, w) => `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="#2c3344" stroke-width="${w}" stroke-linecap="round"/>`;
  const sh = (s) => P(`shoulder.${s}`);
  const hp = (s) => P(`hip.${s}`);
  const torsoPts = [sh('R'), sh('L'), [hp('L')[0] + 3, hp('L')[1] + 2], [hp('R')[0] - 3, hp('R')[1] + 2]].map((q) => q.join(',')).join(' ');
  const body =
    `<polygon points="${torsoPts}" fill="#2c3344" stroke="#2c3344" stroke-width="10" stroke-linejoin="round"/>` +
    limb('neck', 'chest', 14) +
    ['L', 'R'].map((s) => limb(`shoulder.${s}`, `elbow.${s}`, 9) + limb(`elbow.${s}`, `wrist.${s}`, 8) + limb(`wrist.${s}`, `handTip.${s}`, 7) + limb(`hip.${s}`, `knee.${s}`, 12) + limb(`knee.${s}`, `ankle.${s}`, 10) + limb(`ankle.${s}`, `toe.${s}`, 7)).join('') +
    `<ellipse cx="60" cy="24" rx="12" ry="15" fill="#2c3344"/>`;
  const lines = BODY_LINES.filter(([a, b]) => FIG[a] && FIG[b]).map(([a, b]) => `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="#4b5568" stroke-width="1.5"/>`).join('');
  const dots = Object.keys(FIG)
    .map((k) => {
      const [x, y] = P(k);
      if (k === key) return `<circle cx="${x}" cy="${y}" r="9" fill="#fde04733"><animate attributeName="r" values="6;11;6" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="${x}" cy="${y}" r="4.5" fill="#fde047" stroke="#111" stroke-width="1"/>`;
      if (k === partner) return `<circle cx="${x}" cy="${y}" r="3.5" fill="#fbbf24" opacity=".7"/>`;
      return `<circle cx="${x}" cy="${y}" r="2.2" fill="#60a5fa" opacity=".55"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 120 200" width="104" height="173">${body}${lines}${dots}<text x="2" y="198" font-size="8" fill="#7a8396">R</text><text x="112" y="198" font-size="8" fill="#7a8396">L</text></svg>`;
}

/** A hand drawn from above, for the finger markers. */
function handSVG(key) {
  const [id] = key.split('.');
  const f = id.replace(/Tip$/, '');
  const tipKey = id.endsWith('Tip');
  const F = { thumb: [[30, 70], [12, 44]], index: [[40, 40], [36, 8]], middle: [[52, 38], [52, 4]], ring: [[64, 40], [67, 9]], pinky: [[75, 46], [82, 20]] };
  const fingers = Object.entries(F).map(([n, [a, b]]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#2c3344" stroke-width="10" stroke-linecap="round"/>`).join('');
  const dots = Object.entries(F)
    .flatMap(([n, [a, b]]) => [[n, false, a], [n, true, b]])
    .map(([n, tip, [x, y]]) => (n === f && tip === tipKey ? `<circle cx="${x}" cy="${y}" r="8" fill="#fde04733"><animate attributeName="r" values="5;10;5" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="${x}" cy="${y}" r="4" fill="#fde047" stroke="#111"/>` : `<circle cx="${x}" cy="${y}" r="2.4" fill="#60a5fa" opacity=".6"/>`))
    .join('');
  return `<svg viewBox="0 0 100 120" width="104" height="125"><path d="M28 112 L30 62 Q36 40 52 40 Q74 40 80 50 L78 112 Z" fill="#2c3344"/>${fingers}${dots}<text x="34" y="118" font-size="8" fill="#7a8396">wrist</text></svg>`;
}

const info = (key) => {
  const [id, side] = key.split('.');
  const m = markerInfo(id);
  return { ...m, side, title: side ? `${side === 'L' ? 'Left' : 'Right'} ${m.label.toLowerCase()}` : m.label };
};

// Marker -> bone of a skeleton made by Build skeleton (same names every time).
const BONE_OF = { pelvis: 'Hips', chest: 'Chest', neck: 'Neck', headTop: 'HeadTop_End', shoulder: 'UpperArm', elbow: 'ForeArm', wrist: 'Hand', handTip: 'HandTip_End', hip: 'Thigh', knee: 'Calf', ankle: 'Foot', toe: 'Toe' };
const boneFor = (k) => {
  const [id, s] = k.split('.');
  if (!s) return BONE_OF[id];
  if (BONE_OF[id]) return `${BONE_OF[id]}_${s}`;
  const f = id.replace(/Tip$/, '');
  return fingerBones(f, s)[id.endsWith('Tip') ? 3 : 0];
};

/** Joint positions of a skeleton this builder made earlier (null for any other rig); fingers when it has them. */
export function builtMarkers(rig) {
  const out = {};
  for (const k of markerKeys()) {
    const i = rig.byName.get(boneFor(k));
    if (i === undefined) return null;
    out[k] = rig.restWorld.p[i].clone();
  }
  const fingerKeys = markerKeys(true).filter((k) => !(k in out));
  if (fingerKeys.every((k) => rig.byName.has(boneFor(k)))) for (const k of fingerKeys) out[k] = rig.restWorld.p[rig.byName.get(boneFor(k))].clone();
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

const isFinger = (k) => !!markerInfo(k.split('.')[0])?.finger;

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

    this.pts = collectVertices(model.root, 60000);
    this.found = autoFind(model.root);
    this.facing = this.found.facing;
    this.H = this.found.height;
    this.fingers = existing ? !!existing['index.L'] : !!opts.fingers;
    this.pos = {};
    this.state = {};
    const start = existing || this.found.markers;
    for (const k of markerKeys(true)) {
      this.pos[k] = start[k] ? start[k].clone() : new THREE.Vector3();
      this.state[k] = existing && start[k] ? 'placed' : 'auto';
    }
    if (!existing || !existing['index.L']) this.placeFingers();
    // A new skeleton gets fingers when the mesh has real ones (not on mitten or robot-claw hands) unless told otherwise.
    if (!existing && opts.fingers == null) this.fingers = !!(this.fingersFound?.L || this.fingersFound?.R);
    this.symmetry = true;
    this.xray = true;
    this.autoDepth = true;
    this.undoStack = [];
    this.redoStack = [];
    this.current = 'pelvis';
    this.buildVisuals();
    this.buildPanel();
    this.setXray(true);
    const dom = vp.renderer.domElement;
    this.handlers = {
      pointerdown: (e) => this.onPointerDown(e),
      pointermove: (e) => this.onPointerMove(e),
      pointerup: (e) => this.onPointerUp(e),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) dom.addEventListener(ev, fn, true);
    this.onKey = (e) => this.handleKey(e);
    window.addEventListener('keydown', this.onKey, true);
    dom.style.cursor = 'crosshair';
    vp.frameModel('front', 310);
    this.select('pelvis');
  }

  keys() {
    return markerKeys(this.fingers);
  }

  /** Finger markers from the mesh (or the usual layout on mitten hands), for both hands. */
  placeFingers() {
    for (const s of ['L', 'R']) {
      const f = findFingers(this.pts, this.pos[`wrist.${s}`], this.pos[`handTip.${s}`], this.facing, this.H);
      if (!f) continue;
      for (const n of FINGERS) {
        this.pos[`${n}.${s}`].copy(f.base[n]);
        this.pos[`${n}Tip.${s}`].copy(f.tip[n]);
        this.state[`${n}.${s}`] = this.state[`${n}Tip.${s}`] = 'auto';
      }
      this.fingersFound = { ...(this.fingersFound || {}), [s]: f.found };
    }
  }

  // ------------------------------------------------------------------ visuals
  buildVisuals() {
    const scene = this.vp.scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const geo = new THREE.SphereGeometry(this.H * 0.013, 16, 12);
    this.meshes = {};
    for (const k of markerKeys(true)) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#60a5fa', depthTest: false, transparent: true }));
      m.renderOrder = 1002;
      this.group.add(m);
      this.meshes[k] = m;
    }
    const all = [...BODY_LINES, ...FINGER_LINES];
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(all.length * 6), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#fde047', depthTest: false, transparent: true, opacity: 0.7 }));
    this.lines.renderOrder = 1001;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.tip = h('div', { class: 'vp-tip hidden' });
    this.vp.el.append(this.tip);
    // Dots keep the same size on screen, so they stay usable close up (fingers) and far away.
    this.sizeHook = () => {
      const cam = this.vp.camera;
      const px = this.vp.el.clientHeight || 600;
      const unit = 2 * Math.tan(((cam.fov / 2) * Math.PI) / 180) / px; // metres per pixel at distance 1
      const world = new THREE.Vector3();
      for (const k of markerKeys(true)) {
        const m = this.meshes[k];
        if (!m.visible) continue;
        m.getWorldPosition(world);
        const r = (isFinger(k) ? 5 : 7) * (m.userData.boost || 1) * unit * world.distanceTo(cam.position);
        m.scale.setScalar(r / (this.H * 0.013));
      }
    };
    this.vp.frameHooks.push(this.sizeHook);
    this.refresh();
  }

  refresh() {
    for (const k of markerKeys(true)) {
      const m = this.meshes[k];
      const shown = this.fingers || !isFinger(k);
      m.visible = shown;
      if (!shown) continue;
      m.position.copy(this.pos[k]);
      const cur = k === this.current;
      const partner = this.symmetry && k === this.partnerOf(this.current);
      const hover = k === this.hover;
      m.material.color.set(cur ? '#fde047' : partner ? '#fbbf24' : hover ? '#ffffff' : this.state[k] === 'placed' ? '#4ade80' : '#60a5fa');
      m.material.opacity = cur || hover ? 1 : partner ? 0.8 : 0.85;
      m.userData.boost = cur ? 1.5 : hover ? 1.3 : partner ? 1.1 : 1;
    }
    const all = [...BODY_LINES, ...(this.fingers ? FINGER_LINES : [])];
    const pos = this.lines.geometry.attributes.position;
    all.forEach(([a, b], i) => {
      pos.setXYZ(i * 2, this.pos[a].x, this.pos[a].y, this.pos[a].z);
      pos.setXYZ(i * 2 + 1, this.pos[b].x, this.pos[b].y, this.pos[b].z);
    });
    pos.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, all.length * 2);
    this.renderList();
  }

  /** See-through mesh while placing joints, so markers inside the body stay visible. */
  setXray(on) {
    this.xray = on;
    for (const p of app.model.parts) {
      const mats = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material];
      for (const mat of mats) {
        if (on) {
          mat.userData.rbSaved ??= { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
          Object.assign(mat, { transparent: true, opacity: 0.45, depthWrite: false });
        } else if (mat.userData.rbSaved) {
          Object.assign(mat, mat.userData.rbSaved);
          delete mat.userData.rbSaved;
        }
        mat.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------ panel
  buildPanel() {
    this.list = h('div', { class: 'col rb-list', style: { gap: '1px' } });
    this.hint = h('div', { class: 'rb-hint' });
    this.figure = h('div', { class: 'rb-figure' });
    this.fingerNote = h('div', { class: 'muted', style: { fontSize: '12px' } });
    const check = (label, title, on, fn) => h('label', { class: 'check', style: { fontSize: '12px' }, title }, h('input', { type: 'checkbox', checked: on, onchange: (e) => fn(e.target.checked) }), label);
    this.panel = h(
      'div',
      { class: 'rb-panel card' },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, this.editing ? 'Edit skeleton' : 'Build skeleton'), h('button', { class: 'ghost icon', title: 'Cancel', onclick: () => this.close() }, '✕')),
      h('div', { class: 'rb-hint' }, this.editing ? 'Drag any dot to where its joint should be, then press Update skeleton — your animations are kept.' : 'The joints are found automatically. Drag any dot that is off to its joint (or pick one and click the model), then press Build skeleton.'),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'small', onclick: () => this.vp.frameModel('front', 310) }, 'Front'),
        h('button', { class: 'small', onclick: () => this.vp.frameModel('left', 310) }, 'Side'),
        h('button', { class: 'small', title: 'Look at the hand from close up (fingers)', onclick: () => this.frameHand() }, 'Hand'),
        h('button', { class: 'small', title: 'Find all joints from the mesh again', onclick: () => this.autoAgain() }, '↻ Auto-fit'),
        h('button', { class: 'small', title: 'Undo (Ctrl+Z)', onclick: () => this.undo() }, '↶'),
        h('button', { class: 'small', title: 'Redo (Ctrl+Y)', onclick: () => this.redo() }, '↷')
      ),
      h(
        'div',
        { class: 'row wrap', style: { gap: '4px 12px' } },
        check('Mirror left → right', 'Moving a left joint moves the right one the same way', true, (on) => ((this.symmetry = on), this.refresh())),
        check('See through', 'Make the mesh see-through so joints inside it show', true, (on) => this.setXray(on)),
        check('Keep joints inside', 'Dragging from the front keeps the joint in the middle of the body (front to back)', true, (on) => (this.autoDepth = on)),
        check('Fingers', 'Add finger bones: three per finger, five fingers per hand', this.fingers, (on) => this.setFingers(on))
      ),
      this.fingerNote,
      h('div', { class: 'rb-body' }, this.list),
      check('Head moves as one piece (no stretching)', 'Everything above the neck follows the Head bone only, so the head turns and nods without stretching. Untick for soft heads (faces that should squash).', this.rigidHead !== false, (on) => (this.rigidHead = on)),
      h('div', { class: 'row' }, h('button', { class: 'grow', onclick: () => this.close() }, 'Cancel'), h('button', { class: 'primary grow', onclick: () => this.build() }, this.editing ? 'Update skeleton' : 'Build skeleton'))
    );
    // Which joint is being placed: a fixed card on the viewport, so it stays in sight while the list scrolls.
    this.guide = h('div', { class: 'rb-guide card' }, this.figure, this.hint);
    document.getElementById('center').append(this.panel, this.guide);
    this.updateFingerNote();
  }

  setFingers(on) {
    this.fingers = on;
    if (on && !this.fingersPlaced) this.placeFingers();
    this.fingersPlaced = true;
    if (!on && isFinger(this.current || '')) this.current = 'wrist.L';
    this.updateFingerNote();
    this.refresh();
    this.updateFigure();
    if (on) this.frameHand();
  }

  updateFingerNote() {
    if (!this.fingerNote) return;
    clear(this.fingerNote);
    if (!this.fingers) return;
    const seen = this.fingersFound && (this.fingersFound.L || this.fingersFound.R);
    this.fingerNote.append(
      seen ? 'Fingers found on the mesh. Check them in the Hand view. ' : 'The hands look like mittens: the fingers are spread over the hand. Drag them where you want the bends. ',
      h('button', { class: 'small', onclick: () => (this.snapshot(), this.placeFingers(), this.updateFingerNote(), this.refresh()) }, 'Find fingers again')
    );
  }

  renderList() {
    if (!this.list) return;
    clear(this.list);
    const groups = [['Body', this.keys().filter((k) => !isFinger(k))], ...(this.fingers ? [['Fingers', this.keys().filter(isFinger)]] : [])];
    for (const [title, keys] of groups) {
      this.list.append(h('div', { class: 'list-group' }, title));
      for (const k of keys) {
        if (this.symmetry && k.endsWith('.R')) continue;
        const inf = info(k);
        const st = this.state[k];
        this.list.append(
          h(
            'div',
            { class: 'rb-row' + (k === this.current ? ' on' : ''), onclick: () => this.select(k), title: inf.hint },
            h('span', { class: 'swatch', style: { background: k === this.current ? '#fde047' : st === 'placed' ? '#4ade80' : '#60a5fa' } }),
            h('span', { class: 'grow' }, this.symmetry && inf.side ? inf.label : inf.title),
            h('span', { class: 'muted', style: { fontSize: '11px' } }, st === 'placed' ? 'moved' : 'auto')
          )
        );
      }
    }
    if (this.current && this.hint) {
      const inf = info(this.current);
      this.hint.textContent = `${inf.title}: ${inf.hint}. Drag its dot there, or click the model there.`;
    }
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

  updateFigure() {
    if (!this.figure || !this.current) return;
    const k = this.current;
    this.figure.innerHTML = isFinger(k) ? handSVG(k) : figureSVG(k, this.symmetry ? this.partnerOf(k) : null);
  }

  /** Close-up of the left hand (the right one mirrors), from above. */
  frameHand(side = 'L') {
    const vp = this.vp;
    const w = this.pos[`wrist.${side}`],
      t = this.pos[`handTip.${side}`];
    const c = w.clone().lerp(t, 0.5);
    const len = Math.max(w.distanceTo(t), this.H * 0.05);
    const toHand = c.clone().setY(0).normalize();
    const dir = new THREE.Vector3(0, 1, 0).addScaledVector(new THREE.Vector3(0, 0, this.facing), 0.6).addScaledVector(toHand, 0.25).normalize();
    const world = c.clone().applyMatrix4(app.model.root.matrixWorld);
    vp.orbit.target.copy(world);
    vp.camera.position.copy(world).addScaledVector(dir, len * 3.2);
    vp.orbit.update();
  }

  // ------------------------------------------------------------------ editing
  snapshot() {
    this.undoStack.push(Object.fromEntries(Object.entries(this.pos).map(([k, v]) => [k, [v.clone(), this.state[k]]])));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  restore(s) {
    for (const [k, [v, st]] of Object.entries(s)) {
      this.pos[k].copy(v);
      this.state[k] = st;
    }
    this.refresh();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(Object.fromEntries(Object.entries(this.pos).map(([k, v]) => [k, [v.clone(), this.state[k]]])));
    this.restore(s);
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(Object.fromEntries(Object.entries(this.pos).map(([k, v]) => [k, [v.clone(), this.state[k]]])));
    this.restore(s);
  }

  handleKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.target.matches?.('input[type=text], input[type=number], textarea')) return;
    let used = true;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) this.undo();
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) this.redo();
    else if (e.key === 'Tab') this.step(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') this.close();
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  step(dir) {
    const keys = this.keys().filter((k) => !(this.symmetry && k.endsWith('.R')));
    const i = keys.indexOf(this.current);
    this.select(keys[(i + dir + keys.length) % keys.length]);
  }

  set(k, p, state = 'placed') {
    this.pos[k].copy(p);
    this.state[k] = state;
    if (this.symmetry && k.endsWith('.L')) {
      const r = k.replace('.L', '.R');
      this.pos[r].copy(mirrorMarker(p, this.pos.pelvis.x));
      this.state[r] = state;
    } else if (this.symmetry && k.endsWith('.R')) {
      const l = k.replace('.R', '.L');
      this.pos[l].copy(mirrorMarker(p, this.pos.pelvis.x));
      this.state[l] = state;
    }
    if (this.symmetry && k === 'pelvis') {
      // keep pairs symmetric around the new centre
      for (const key of markerKeys(true)) if (key.endsWith('.L')) this.pos[key.replace('.L', '.R')].copy(mirrorMarker(this.pos[key], p.x));
    }
  }

  /** The middle of the body front-to-back at a marker's height and sideways position. */
  centreDepth(p) {
    const r = this.H * (isFinger(this.current) ? 0.008 : 0.02);
    let lo = Infinity,
      hi = -Infinity;
    for (const q of this.pts)
      if (Math.abs(q.x - p.x) < r && Math.abs(q.y - p.y) < r) {
        if (q.z < lo) lo = q.z;
        if (q.z > hi) hi = q.z;
      }
    return lo <= hi ? (lo + hi) / 2 : p.z;
  }

  /** Is the camera looking at the model from the front or back (so depth is not under control)? */
  frontish() {
    const d = new THREE.Vector3();
    this.vp.camera.getWorldDirection(d);
    d.applyQuaternion(app.model.root.getWorldQuaternion(new THREE.Quaternion()).invert());
    return Math.abs(d.z) > 0.8;
  }

  screenOf(k) {
    const vp = this.vp;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const v = this.pos[k].clone().applyMatrix4(app.model.root.matrixWorld).project(vp.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** The marker under the mouse (the selected one wins ties). */
  markerAt(e, maxPx = 14) {
    let best = null,
      bd = maxPx;
    for (const k of this.keys()) {
      const s = this.screenOf(k);
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY) - (k === this.current ? 3 : 0);
      if (d < bd) [bd, best] = [d, k];
    }
    return best;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const k = this.markerAt(e);
    if (!k) return; // empty space: orbit, or a click places the selected joint (onClick)
    e.stopImmediatePropagation();
    e.preventDefault();
    const vp = this.vp;
    vp.orbit.enabled = false;
    vp.down = null;
    this.snapshot();
    this.grab = k;
    this.moveAll = e.shiftKey && k === 'pelvis';
    if (k !== this.current) this.select(k);
    const world = this.pos[k].clone().applyMatrix4(app.model.root.matrixWorld);
    const normal = new THREE.Vector3();
    vp.camera.getWorldDirection(normal);
    this.dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
    this.dragFrom = this.pos[k].clone();
    this.dragAll = this.moveAll ? Object.fromEntries(Object.entries(this.pos).map(([key, v]) => [key, v.clone()])) : null;
    vp.renderer.domElement.setPointerCapture(e.pointerId);
    vp.renderer.domElement.style.cursor = 'grabbing';
  }

  onPointerMove(e) {
    const vp = this.vp;
    if (!this.dragPlane) {
      const k = this.markerAt(e);
      if (k !== this.hover) {
        this.hover = k;
        this.refresh();
      }
      vp.renderer.domElement.style.cursor = k ? 'grab' : 'crosshair';
      if (k) {
        const r = vp.el.getBoundingClientRect();
        this.tip.textContent = `${info(k).title}${k === 'pelvis' ? '  ·  Shift+drag moves everything' : ''}`;
        this.tip.style.left = e.clientX - r.left + 14 + 'px';
        this.tip.style.top = e.clientY - r.top + 12 + 'px';
        this.tip.classList.remove('hidden');
      } else this.tip.classList.add('hidden');
      return;
    }
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), vp.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this.dragPlane, hit)) return;
    hit.applyMatrix4(app.model.root.matrixWorld.clone().invert());
    if (this.moveAll) {
      const d = hit.sub(this.dragFrom);
      for (const [key, v] of Object.entries(this.dragAll)) this.pos[key].copy(v).add(d);
    } else this.set(this.grab, hit);
    this.refresh();
  }

  onPointerUp() {
    if (!this.dragPlane) return;
    const k = this.grab;
    this.dragPlane = null;
    this.grab = null;
    if (!this.moveAll && this.autoDepth && this.frontish()) {
      const p = this.pos[k].clone();
      p.z = this.centreDepth(p);
      this.set(k, p);
    }
    this.moveAll = false;
    this.vp.orbit.enabled = true;
    this.vp.down = null;
    this.vp.renderer.domElement.style.cursor = 'crosshair';
    this.refresh();
  }

  autoAgain() {
    this.snapshot();
    this.found = autoFind(app.model.root);
    for (const k of markerKeys()) {
      this.pos[k].copy(this.found.markers[k]);
      this.state[k] = 'auto';
    }
    this.placeFingers();
    this.updateFingerNote();
    this.refresh();
  }

  // ------------------------------------------------------------------ input
  /** A click on the model (not on a dot) puts the selected joint inside the body there. */
  onClick(e) {
    const vp = this.vp;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, vp.camera);
    const hits = ray.intersectObjects(app.model.meshes.filter((m) => m.visible), false);
    if (!hits.length) return;
    const first = hits[0];
    const back = hits.find((x) => x.distance > first.distance + this.H * 0.002 && x.distance - first.distance < this.H * (isFinger(this.current) ? 0.06 : 0.35));
    const inv = app.model.root.matrixWorld.clone().invert();
    const p = back ? first.point.clone().lerp(back.point, 0.5) : first.point.clone().addScaledVector(ray.ray.direction, this.H * 0.01);
    p.applyMatrix4(inv);
    this.snapshot();
    this.set(this.current, p);
    this.refresh();
  }

  onGizmo() {}

  // ------------------------------------------------------------------ finish
  cleanup() {
    const vp = this.vp;
    vp.gizmo.detach();
    const dom = vp.renderer.domElement;
    for (const [ev, fn] of Object.entries(this.handlers || {})) dom.removeEventListener(ev, fn, true);
    window.removeEventListener('keydown', this.onKey, true);
    dom.style.cursor = '';
    vp.orbit.enabled = true;
    if (app.model) this.setXray(false);
    vp.frameHooks = vp.frameHooks.filter((f) => f !== this.sizeHook);
    if (this.group) {
      vp.scene.remove(this.group);
      this.group.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()));
    }
    this.tip?.remove();
    this.panel?.remove();
    this.guide?.remove();
    this.panel = this.guide = this.list = this.hint = null;
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
    for (const k of this.keys()) markers[k] = this.pos[k].clone();
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
