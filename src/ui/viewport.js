// 3D viewport: model display, bone picking/manipulation (FK + IK), onion skin, ghosts, trails.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { app } from '../app/state.js';
import { applyPose } from '../core/evaluate.js';
import { GROUP_BY_ID, boneTitle } from '../core/rig.js';
import { solveTwoBone, bendHintFor } from '../core/ik.js';
import { jointPath } from '../core/analysis.js';
import { boneKeyTimes } from '../core/clip.js';
import { afterManualPose, hooks, keyBones } from '../app/actions.js';
import { h } from './dom.js';

const V3 = THREE.Vector3;
const _v = new V3();
const _q = new THREE.Quaternion();

export class Viewport {
  constructor(el) {
    this.el = el;
    this.model = null;
    this.needsEval = true;
    this.ghostsDirty = true;
    this.dragging = false;
    this.unkeyed = new Set();
    this.hover = -1;
    this.onion = [];
    this.compare = null;
    this.trailKey = '';
    this.frameHooks = []; // run before every render (e.g. props following their sockets)
    this.initRenderer();
    this.initScene();
    this.initGizmo();
    this.initPicking();
    this.bindApp();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.timer = new THREE.Timer();
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
    hooks.refreshPose = () => (this.needsEval = true);
    hooks.posePreview = (indices) => this.markUnkeyed(indices);
    hooks.thumbnail = (size = 192) => (this.model ? this.capture(size) : null);
  }

  // ------------------------------------------------------------------ setup
  initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.el.append(r.domElement);
    r.domElement.tabIndex = 0;
    this.tip = h('div', { class: 'vp-tip hidden' });
    this.el.append(this.tip);
  }

  initScene() {
    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 2000);
    this.camera.position.set(3, 2, 5);
    const orbit = (this.orbit = new OrbitControls(this.camera, this.renderer.domElement));
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.18;
    orbit.screenSpacePanning = true;
    orbit.target.set(0, 1, 0);
    scene.add(new THREE.HemisphereLight(0xe8eeff, 0x302a26, 1.5));
    const key = (this.keyLight = new THREE.DirectionalLight(0xffffff, 2.1));
    key.position.set(2.5, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0x9db8ff, 0.9);
    rim.position.set(-3, 3, -4);
    scene.add(rim);
    this.grid = new THREE.GridHelper(20, 40, 0x3b4255, 0x262b37);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.85;
    scene.add(this.grid);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);
    this.overlay = new THREE.Group();
    scene.add(this.overlay);
  }

  initGizmo() {
    const g = (this.gizmo = new TransformControls(this.camera, this.renderer.domElement));
    g.setSize(app.settings.gizmoSize);
    g.setSpace(app.settings.gizmoSpace);
    this.scene.add(g.getHelper());
    this.ikProxy = new THREE.Object3D();
    this.scene.add(this.ikProxy);
    g.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (this.builder) return this.builder.onGizmo(e.value ? 'start' : 'end');
      if (e.value) this.onDragStart();
      else this.onDragEnd();
    });
    g.addEventListener('objectChange', () => (this.builder ? this.builder.onGizmo('move') : this.onDragMove()));
  }

  initPicking() {
    const dom = this.renderer.domElement;
    // Capture phase: decide before OrbitControls whether this press grabs a joint dot.
    dom.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        const onGizmo = !!(this.gizmo.object && this.gizmo.axis);
        this.down = { x: e.clientX, y: e.clientY, onGizmo };
        this.direct = null;
        if (onGizmo || !this.model || this.builder || this.preview) return;
        const i = this.pick(e.clientX, e.clientY);
        if (i >= 0 && this.directKind(i)) {
          this.direct = { i, started: false };
          this.orbit.enabled = false; // dragging a dot poses the character instead of turning the camera
        }
      },
      true
    );
    dom.addEventListener('pointermove', (e) => {
      const d = this.direct;
      if (!d || !(e.buttons & 1)) return;
      if (!d.started) {
        if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 4) return;
        this.beginDirect(d);
      }
      this.moveDirect(e.clientX, e.clientY);
    });
    dom.addEventListener('pointerup', (e) => {
      if (this.direct) {
        const d = this.direct;
        this.direct = null;
        this.orbit.enabled = true;
        if (d.started) {
          this.endDirect(d);
          this.down = null;
          return;
        }
      }
      const d = this.down;
      this.down = null;
      if (!d || e.button !== 0 || !this.model) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || d.onGizmo || this.dragging) return;
      if (this.builder) return this.builder.onClick(e);
      const i = this.pick(e.clientX, e.clientY);
      if (i >= 0) app.selectBones([i], { mode: e.shiftKey ? 'add' : e.ctrlKey ? 'toggle' : 'replace', active: i });
      else if (!e.shiftKey && !e.ctrlKey) app.clearBones();
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.dragging || e.buttons || !this.model || this.builder) return this.setHover(-1);
      this.setHover(this.pick(e.clientX, e.clientY), e);
    });
    dom.addEventListener('pointerleave', () => this.setHover(-1));
    dom.addEventListener('dblclick', (e) => {
      const i = this.pick(e.clientX, e.clientY);
      if (i >= 0) this.frameSelection();
    });
  }

  bindApp() {
    const dirty = () => {
      this.needsEval = true;
      this.ghostsDirty = true;
    };
    app.on('model', () => this.setModel(app.model));
    app.on('time', dirty);
    app.on('clip', () => {
      dirty();
      this.trailKey = '';
    });
    app.on('clipSelect', () => {
      dirty();
      this.trailKey = '';
      this.unkeyed.clear();
      this.updateWarn();
    });
    app.on('layer', dirty);
    app.on('selection', () => {
      this.attachGizmo();
      this.trailKey = '';
      if (app.settings.weightView) this.applyMaterials();
    });
    app.on('settings', (k) => this.onSetting(k));
    app.on('rigNames', () => {});
  }

  // ------------------------------------------------------------------ model
  setModel(model) {
    this.gizmo.detach();
    if (this.model) {
      this.scene.remove(this.model.root);
      this.disposeGhosts();
      this.overlay.clear();
    }
    this.model = model;
    this.unkeyed.clear();
    this.updateWarn();
    if (!model) return;
    this.scene.add(model.root);
    const rig = model.rig;
    const H = rig.height;
    this.grid.position.y = rig.ground;
    this.grid.scale.setScalar(Math.max(0.2, H / 2));
    this.ground.position.y = rig.ground - 0.001;
    this.ground.scale.setScalar(H * 12);
    const c = model.box.getCenter(new V3());
    const k = this.keyLight;
    k.target.position.copy(c);
    k.position.copy(c).add(new V3(1.2, 2.6, 1.8).multiplyScalar(H));
    Object.assign(k.shadow.camera, { left: -H, right: H, top: H, bottom: -H, near: 0.01, far: H * 8 });
    k.shadow.camera.updateProjectionMatrix();
    this.camera.near = H / 300;
    this.camera.far = H * 300;
    this.camera.updateProjectionMatrix();
    this.buildJoints();
    this.applyMaterials();
    this.applyVisibility();
    this.view('persp');
    this.needsEval = true;
    this.ghostsDirty = true;
    this.trailKey = '';
  }

  // ------------------------------------------------------------------ joints & bone lines
  jointVisible(i) {
    const rig = this.model.rig;
    if (app.settings.showAllBones) return true;
    if (rig.core.has(i)) return true;
    if (rig.kind[i]?.startsWith('weapon')) return true;
    if (rig.group[i] === 'extra') return rig.children[i].length > 0 || (rig.parent[i] >= 0 && rig.group[rig.parent[i]] === 'extra');
    return false;
  }

  buildJoints() {
    const rig = this.model.rig;
    const H = rig.height;
    this.overlay.clear();
    const geo = new THREE.SphereGeometry(1, 14, 10);
    const mk = (color, opacity = 0.92) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
    this.mats = Object.fromEntries(Object.values(GROUP_BY_ID).map((g) => [g.id, mk(g.color)]));
    this.matSel = mk('#fde047', 1);
    this.matActive = mk('#ffffff', 1);
    this.matHover = mk('#e2e8f0', 1);
    this.radius = rig.bones.map((_, i) => {
      const kind = rig.kind[i] || '';
      let f = 1;
      if (kind.startsWith('finger')) f = 0.55;
      else if (rig.group[i] === 'extra') f = 0.65;
      else if (rig.group[i] === 'attach') f = 0.5;
      else if (kind === 'hips' || kind === 'root') f = 1.35;
      return H * 0.0105 * f;
    });
    this.joints = rig.bones.map((b, i) => {
      const m = new THREE.Mesh(geo, this.mats[rig.group[i]]);
      m.renderOrder = 1000;
      this.overlay.add(m);
      return m;
    });
    const segs = rig.bones.length;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.75 }));
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.overlay.add(this.lines);
    // IK target marker
    this.ikMarker = new THREE.Mesh(new THREE.OctahedronGeometry(H * 0.022), new THREE.MeshBasicMaterial({ color: '#f472b6', depthTest: false, transparent: true, opacity: 0.9 }));
    this.ikMarker.renderOrder = 1001;
    this.ikMarker.visible = false;
    this.overlay.add(this.ikMarker);
    // trail
    this.trailLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    this.trailLine.renderOrder = 998;
    this.trailLine.frustumCulled = false;
    this.trailKeys = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: '#fbbf24', size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.trailKeys.renderOrder = 999;
    this.trailKeys.frustumCulled = false;
    this.overlay.add(this.trailLine, this.trailKeys);
    this.boneColors = rig.bones.map((_, i) => new THREE.Color(GROUP_BY_ID[rig.group[i]].color).multiplyScalar(0.85));
  }


  updateOverlay() {
    const rig = this.model.rig;
    const showJ = app.settings.showJoints;
    const showL = app.settings.showSkeleton;
    const pos = this.lines.geometry.attributes.position;
    const scale = app.settings.jointScale;
    const sel = app.sel.bones;
    let seg = 0;
    for (let i = 0; i < rig.bones.length; i++) {
      const m = this.joints[i];
      const vis = this.jointVisible(i);
      rig.bones[i].getWorldPosition(m.position);
      m.visible = showJ && (vis || sel.has(i));
      if (m.visible) {
        const active = i === app.sel.active;
        m.material = active ? this.matActive : sel.has(i) ? this.matSel : i === this.hover ? this.matHover : this.mats[rig.group[i]];
        m.scale.setScalar(this.radius[i] * scale * (active ? 1.55 : sel.has(i) ? 1.3 : i === this.hover ? 1.3 : 1));
      }
      const p = rig.parent[i];
      if (showL && p >= 0 && vis && this.jointVisible(p)) {
        pos.setXYZ(seg * 2, this.joints[p].position.x, this.joints[p].position.y, this.joints[p].position.z);
        pos.setXYZ(seg * 2 + 1, m.position.x, m.position.y, m.position.z);
        const col = this.lines.geometry.attributes.color;
        const cc = this.boneColors[i];
        col.setXYZ(seg * 2, cc.r, cc.g, cc.b);
        col.setXYZ(seg * 2 + 1, cc.r, cc.g, cc.b);
        seg++;
      }
    }
    pos.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, seg * 2);
    this.lines.visible = showL;
    if (this.ikLimb && this.gizmo.object === this.ikProxy) {
      this.ikMarker.visible = true;
      this.ikMarker.position.copy(this.ikProxy.position);
    } else this.ikMarker.visible = false;
  }

  pick(cx, cy) {
    if (!this.model || !app.settings.showJoints) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best = -1,
      bd = 13;
    for (let i = 0; i < this.joints.length; i++) {
      const m = this.joints[i];
      if (!m.visible) continue;
      _v.copy(m.position).project(this.camera);
      if (_v.z > 1) continue;
      const sx = rect.left + ((_v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - _v.y) / 2) * rect.height;
      const d = Math.hypot(sx - cx, sy - cy) - (this.model.rig.core.has(i) ? 2 : 0);
      if (d < bd) [bd, best] = [d, i];
    }
    return best;
  }

  setHover(i, e) {
    if (i !== this.hover) this.hover = i;
    if (i < 0 || !e) {
      this.tip.classList.add('hidden');
      return;
    }
    const rig = this.model.rig;
    const title = boneTitle(rig, i, app.nick);
    const raw = rig.names[i];
    this.tip.textContent = title === raw ? raw : `${title}  ·  ${raw}`;
    const r = this.el.getBoundingClientRect();
    this.tip.style.left = e.clientX - r.left + 14 + 'px';
    this.tip.style.top = e.clientY - r.top + 12 + 'px';
    this.tip.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ direct dot dragging
  /** How a joint dot reacts to dragging: 'ik' (hand/foot end), 'move' (hips/root), 'aim' (swing the parent bone). */
  directKind(i) {
    const rig = this.model.rig;
    if (Object.values(rig.ik).some((ik) => ik.end === i)) return 'ik';
    if (i === rig.special.hips || i === rig.special.root) return 'move';
    const p = rig.parent[i];
    if (p < 0 || p === rig.special.hips || p === rig.special.root || rig.group[i] === 'attach') return null;
    return 'aim';
  }

  beginDirect(d) {
    const rig = this.model.rig;
    d.started = true;
    d.kind = this.directKind(d.i);
    app.setPlaying(false);
    if (this.needsEval) this.evaluate();
    app.selectBones([d.i], { mode: 'replace', active: d.i });
    this.gizmo.detach();
    this.dragging = true;
    this.model.root.updateMatrixWorld(true);
    const bone = rig.bones[d.i];
    const pos = bone.getWorldPosition(new V3());
    d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new V3()).negate(), pos);
    d.grab = pos.clone();
    d.raycaster = new THREE.Raycaster();
    if (d.kind === 'ik') {
      d.ik = Object.values(rig.ik).find((ik) => ik.end === d.i);
      d.bones = [d.ik.upper, d.ik.lower, d.ik.end];
    } else if (d.kind === 'move') {
      d.startLocal = bone.position.clone();
      d.bones = [d.i];
    } else d.bones = [rig.parent[d.i]];
  }

  moveDirect(cx, cy) {
    const d = this.direct;
    const rig = this.model.rig;
    const r = this.renderer.domElement.getBoundingClientRect();
    d.raycaster.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    const hit = d.raycaster.ray.intersectPlane(d.plane, new V3());
    if (!hit) return;
    const bone = rig.bones[d.i];
    if (d.kind === 'ik') {
      // keeps the current elbow/knee bend plane and the hand/foot orientation
      solveTwoBone(rig.bones[d.ik.upper], rig.bones[d.ik.lower], bone, hit, { keepEndRotation: true });
    } else if (d.kind === 'move') {
      const world = bone.parent.localToWorld(d.startLocal.clone()).add(hit.clone().sub(d.grab));
      bone.position.copy(bone.parent.worldToLocal(world));
      bone.updateMatrixWorld(true);
    } else {
      const parent = rig.bones[rig.parent[d.i]];
      const a = parent.getWorldPosition(new V3());
      const cur = bone.getWorldPosition(new V3()).sub(a);
      const want = hit.clone().sub(a);
      if (cur.lengthSq() < 1e-10 || want.lengthSq() < 1e-10) return;
      const q = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want.normalize());
      const pq = parent.parent ? parent.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      parent.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq)).normalize();
      parent.updateMatrixWorld(true);
    }
    app.emit('pose');
  }

  endDirect(d) {
    this.dragging = false;
    afterManualPose(d.bones, d.kind === 'ik' ? 'Drag hand/foot' : d.kind === 'move' ? 'Move body' : 'Drag joint');
    this.attachGizmo();
  }

  // ------------------------------------------------------------------ gizmo / posing
  limbFor(i) {
    const rig = this.model.rig;
    for (const [name, ik] of Object.entries(rig.ik)) {
      if ([ik.upper, ik.lower, ik.end].includes(i)) return { name, ...ik };
      for (let p = rig.parent[i]; p >= 0; p = rig.parent[p]) if (p === ik.end) return { name, ...ik };
    }
    return null;
  }

  attachGizmo() {
    if (this.builder) return;
    const i = app.sel.active;
    const tool = app.settings.tool;
    this.ikLimb = null;
    if (!this.model || i < 0 || tool === 'select') return this.gizmo.detach();
    const rig = this.model.rig;
    if (tool === 'ik') {
      const limb = this.limbFor(i);
      if (!limb) {
        this.gizmo.setMode('rotate');
        this.gizmo.setSpace(app.settings.gizmoSpace);
        this.gizmo.attach(rig.bones[i]);
        return;
      }
      this.ikLimb = limb;
      this.model.root.updateMatrixWorld(true);
      rig.bones[limb.end].getWorldPosition(this.ikProxy.position);
      this.ikProxy.quaternion.identity();
      this.ikProxy.updateMatrixWorld(true);
      this.gizmo.setMode('translate');
      this.gizmo.setSpace('world');
      this.gizmo.attach(this.ikProxy);
      return;
    }
    this.gizmo.setMode(tool === 'move' ? 'translate' : tool === 'scale' ? 'scale' : 'rotate');
    this.gizmo.setSpace(app.settings.gizmoSpace);
    this.gizmo.attach(rig.bones[i]);
  }

  onDragStart() {
    this.dragging = true;
    app.setPlaying(false);
    if (this.needsEval) {
      // make sure the pose we start from is the evaluated one
      this.evaluate();
    }
    const rig = this.model.rig;
    const i = app.sel.active;
    this.dragKeys = new Set([i]);
    this.feet = null;
    if (this.ikLimb) {
      const l = this.ikLimb;
      [l.upper, l.lower, l.end].forEach((b) => this.dragKeys.add(b));
    } else if (app.settings.lockFeet && rig.group[i] === 'torso') {
      this.model.root.updateMatrixWorld(true);
      this.feet = ['L', 'R']
        .map((s) => rig.ik[`foot.${s}`])
        .filter(Boolean)
        .map((ik) => ({ ik, pos: rig.bones[ik.end].getWorldPosition(new V3()), quat: rig.bones[ik.end].getWorldQuaternion(new THREE.Quaternion()) }));
      for (const f of this.feet) [f.ik.upper, f.ik.lower, f.ik.end].forEach((b) => this.dragKeys.add(b));
    }
  }

  onDragMove() {
    if (!this.dragging) return;
    const rig = this.model.rig;
    if (this.ikLimb) {
      const l = this.ikLimb;
      this.ikProxy.updateMatrixWorld(true);
      solveTwoBone(rig.bones[l.upper], rig.bones[l.lower], rig.bones[l.end], this.ikProxy.position, { bendHint: bendHintFor(rig, l.bend), keepEndRotation: true });
    }
    if (this.feet) {
      this.model.root.updateMatrixWorld(true);
      const hint = bendHintFor(rig, 'forward');
      for (const f of this.feet) {
        const e = rig.bones[f.ik.end];
        solveTwoBone(rig.bones[f.ik.upper], rig.bones[f.ik.lower], e, f.pos, { bendHint: hint, keepEndRotation: false });
        e.parent.getWorldQuaternion(_q);
        e.quaternion.copy(_q.invert().multiply(f.quat));
        e.updateWorldMatrix(false, true);
      }
    }
    app.emit('pose');
  }

  onDragEnd() {
    this.dragging = false;
    const bones = [...(this.dragKeys || [])].filter((i) => i >= 0);
    this.dragKeys = null;
    this.feet = null;
    if (bones.length) afterManualPose(bones, this.ikLimb ? 'IK pose' : app.settings.tool === 'move' ? 'Move bone' : 'Rotate bone');
    if (this.ikLimb) this.attachGizmo();
  }

  markUnkeyed(indices) {
    indices.forEach((i) => this.unkeyed.add(i));
    this.updateWarn();
    app.emit('pose');
  }

  updateWarn() {
    const w = document.getElementById('vpWarn');
    if (!w) return;
    if (!this.unkeyed.size) return w.classList.add('hidden');
    w.replaceChildren(
      h('span', {}, `⚠ ${this.unkeyed.size} bone${this.unkeyed.size > 1 ? 's' : ''} changed but not keyed`),
      h('button', { class: 'small', onclick: () => keyBones([...this.unkeyed], { label: 'Key changes' }) }, 'Key now (K)'),
      h('button', { class: 'small', onclick: () => ((this.needsEval = true), this.unkeyed.clear(), this.updateWarn()) }, 'Discard')
    );
    w.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ evaluation & ghosts
  evaluate() {
    const clip = app.clip;
    applyPose(clip, app.time, this.model.rig);
    this.model.root.updateMatrixWorld(true);
    this.needsEval = false;
    if (this.unkeyed.size) {
      this.unkeyed.clear();
      this.updateWarn();
    }
    if (this.gizmo.object === this.ikProxy && this.ikLimb && !this.dragging) {
      this.model.rig.bones[this.ikLimb.end].getWorldPosition(this.ikProxy.position);
    }
    app.emit('pose');
  }

  makeGhost(color, opacity) {
    const root = SkeletonUtils.clone(this.model.root);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    root.traverse((o) => {
      if (o.isMesh) {
        o.material = mat;
        o.castShadow = false;
        o.frustumCulled = false;
      }
    });
    const byName = new Map();
    root.traverse((o) => o.isBone && byName.set(o.name, o));
    const bones = this.model.rig.names.map((n) => byName.get(n));
    this.scene.add(root);
    return { root, bones, mat };
  }

  disposeGhosts() {
    for (const g of [...this.onion, this.compare].filter(Boolean)) {
      this.scene.remove(g.root);
      g.mat.dispose();
    }
    this.onion = [];
    this.compare = null;
  }

  updateGhosts() {
    this.ghostsDirty = false;
    if (!this.model) return;
    const s = app.settings;
    const clip = app.clip;
    const nOnion = s.onion && clip ? s.onionBefore + s.onionAfter : 0;
    if (this.onion.length !== nOnion) {
      this.onion.forEach((g) => (this.scene.remove(g.root), g.mat.dispose()));
      this.onion = [];
      for (let k = 0; k < nOnion; k++) {
        const before = k < s.onionBefore;
        const dist = before ? s.onionBefore - k : k - s.onionBefore + 1;
        this.onion.push(this.makeGhost(before ? '#ff6b6b' : '#4ade80', 0.26 / dist));
      }
    }
    if (nOnion) {
      const d = clip.duration;
      this.onion.forEach((g, k) => {
        const before = k < s.onionBefore;
        const dist = before ? s.onionBefore - k : k - s.onionBefore + 1;
        let t = app.time + (before ? -1 : 1) * dist * (s.onionStep / app.fps);
        if (clip.loop && d > 0) t = ((t % d) + d) % d;
        g.root.visible = t >= -1e-6 && t <= d + 1e-6;
        if (g.root.visible) applyPose(clip, t, this.model.rig, g.bones);
      });
    }
    const cmp = app.compareClipId ? app.clipById(app.compareClipId) : null;
    if (cmp && !this.compare) this.compare = this.makeGhost('#60a5fa', 0.28);
    if (!cmp && this.compare) {
      this.scene.remove(this.compare.root);
      this.compare.mat.dispose();
      this.compare = null;
    }
    if (cmp) applyPose(cmp, Math.min(app.time, cmp.duration), this.model.rig, this.compare.bones);
  }

  updateTrail() {
    const clip = app.clip;
    const i = app.sel.active;
    const on = app.settings.trail && clip && i >= 0;
    this.trailLine.visible = this.trailKeys.visible = !!on;
    if (!on) return;
    const key = `${clip.id}|${app.version}|${i}|${clip.duration}|${app.layerId}`;
    if (key === this.trailKey) return;
    this.trailKey = key;
    const path = jointPath(clip, this.model.rig, i, { fps: app.fps });
    const pos = new Float32Array(path.length * 3);
    const col = new Float32Array(path.length * 3);
    const a = new THREE.Color('#38bdf8'),
      b = new THREE.Color('#f472b6'),
      c = new THREE.Color();
    path.forEach((p, k) => {
      p.p.toArray(pos, k * 3);
      c.copy(a).lerp(b, k / Math.max(1, path.length - 1)).toArray(col, k * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.trailLine.geometry.dispose();
    this.trailLine.geometry = g;
    const keys = app.layer ? boneKeyTimes(app.layer, this.model.rig.names[i]) : [];
    const kp = [];
    for (const t of keys) {
      const k = Math.round((t / (clip.duration || 1)) * (path.length - 1));
      if (path[k]) kp.push(...path[k].p.toArray());
    }
    const kg = new THREE.BufferGeometry();
    kg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kp), 3));
    this.trailKeys.geometry.dispose();
    this.trailKeys.geometry = kg;
  }

  // ------------------------------------------------------------------ materials / view options
  applyMaterials() {
    if (!this.model) return;
    const s = app.settings;
    const i = app.sel.active;
    const weight = s.weightView && i >= 0;
    if (weight && !this.weightMat) this.weightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    for (const p of this.model.parts) {
      const mats = Array.isArray(p.material) ? p.material : [p.material];
      mats.forEach((m) => {
        m.alphaTest = s.alphaCut ? 0.5 : 0;
        m.needsUpdate = true;
      });
      if (weight) {
        this.computeWeights(p.mesh, this.model.rig.bones[i]);
        p.mesh.material = this.weightMat;
      } else p.mesh.material = p.material;
    }
  }

  computeWeights(mesh, bone) {
    const g = mesh.geometry;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    if (!si || !sw) return;
    const idx = mesh.skeleton.bones.indexOf(bone);
    const n = si.count;
    let col = g.attributes.color;
    if (!col || col.count !== n) {
      col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      g.setAttribute('color', col);
    }
    const c = new THREE.Color();
    for (let v = 0; v < n; v++) {
      let w = 0;
      for (let k = 0; k < si.itemSize; k++) if (si.getComponent(v, k) === idx) w += sw.getComponent(v, k);
      if (w <= 0.001) c.setRGB(0.09, 0.11, 0.2);
      else c.setHSL((1 - Math.min(1, w)) * 0.62, 0.9, 0.5);
      col.setXYZ(v, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  applyVisibility() {
    if (!this.model) return;
    const s = app.settings;
    for (const p of this.model.parts) p.mesh.visible = s.showMesh && !p.hidden;
    this.keyLight.castShadow = s.shadows;
    this.ground.visible = s.shadows;
  }

  onSetting(k) {
    if (!this.model) return;
    if (['tool', 'gizmoSpace'].includes(k)) this.attachGizmo();
    if (k === 'gizmoSize') this.gizmo.setSize(app.settings.gizmoSize);
    if (k?.startsWith('onion')) this.ghostsDirty = true;
    if (k === 'trail') this.trailKey = '';
    if (['weightView', 'alphaCut'].includes(k)) this.applyMaterials();
    if (['showMesh', 'shadows'].includes(k)) this.applyVisibility();
  }

  // ------------------------------------------------------------------ camera
  axes() {
    const rig = this.model.rig;
    const fwd = new V3();
    fwd[rig.forwardAxis] = rig.forwardSign;
    const left = new V3().crossVectors(new V3(0, 1, 0), fwd);
    return { fwd, left, up: new V3(0, 1, 0) };
  }

  view(name) {
    if (!this.model) return;
    const { fwd, left, up } = this.axes();
    const center = this.model.box.getCenter(new V3());
    const H = this.model.rig.height;
    const dirs = {
      front: fwd,
      back: fwd.clone().negate(),
      left: left,
      right: left.clone().negate(),
      top: up.clone().addScaledVector(fwd, 0.001),
      persp: fwd.clone().multiplyScalar(0.85).addScaledVector(left, -0.5).addScaledVector(up, 0.22),
    };
    const d = (dirs[name] || dirs.persp).clone().normalize();
    const dist = (H * 0.62) / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.orbit.update();
  }

  /** Look from a named direction and fit the whole model (width and height), leaving padLeft pixels free. */
  frameModel(name = 'front', padLeft = 0) {
    if (!this.model) return;
    this.view(name);
    const box = this.model.box;
    const center = box.getCenter(new V3());
    const size = box.getSize(new V3());
    const { fwd, left } = this.axes();
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const side = new V3().crossVectors(new V3(0, 1, 0), dir).normalize();
    const w = Math.abs(side.dot(new V3(size.x, 0, 0))) + Math.abs(side.dot(new V3(0, 0, size.z)));
    const W = this.el.clientWidth,
      Hp = this.el.clientHeight;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const avail = Math.max(100, W - padLeft - 30);
    const hfovEff = 2 * Math.atan(Math.tan(vfov / 2) * (avail / Hp));
    const dist = Math.max((size.y * 0.58) / Math.tan(vfov / 2), (w * 0.58) / Math.tan(hfovEff / 2)) + size.length() * 0.1;
    // shift so the model is centred in the free area right of the panel
    const visibleW = 2 * Math.tan(vfov / 2) * dist * (W / Hp);
    const shift = (padLeft / 2 / W) * visibleW;
    const target = center.clone().addScaledVector(side, -shift);
    void fwd;
    void left;
    this.orbit.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.orbit.update();
  }

  frameSelection() {
    if (!this.model) return;
    const rig = this.model.rig;
    const pts = [...app.sel.bones].map((i) => rig.bones[i].getWorldPosition(new V3()));
    let center, radius;
    if (pts.length) {
      const box = new THREE.Box3().setFromPoints(pts);
      center = box.getCenter(new V3());
      radius = Math.max(box.getSize(new V3()).length() / 2, rig.height * 0.12);
    } else {
      center = this.model.box.getCenter(new V3());
      radius = rig.height * 0.6;
    }
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const dist = (radius * 1.25) / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.orbit.update();
  }

  /**
   * Square JPEG thumbnail of the character in its current pose (no helpers). It uses its own
   * 3/4 front camera fitted to the posed skeleton, so wherever the user has zoomed or panned, the
   * picture shows the whole character.
   */
  capture(size = 128) {
    const hide = [this.overlay, this.gizmo.getHelper(), this.grid, ...this.onion.map((g) => g.root), this.compare?.root].filter(Boolean);
    const prev = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const rig = this.model.rig;
    const box = new THREE.Box3().setFromPoints(rig.bones.map((b) => b.getWorldPosition(new V3())));
    box.expandByScalar(Math.max(box.getSize(new V3()).length() * 0.06, 1e-3)); // the mesh around the bones
    const center = box.getCenter(new V3());
    const radius = box.getSize(new V3()).length() / 2;
    const { fwd, left, up } = this.axes();
    const dir = fwd.clone().multiplyScalar(0.85).addScaledVector(left, -0.5).addScaledVector(up, 0.22).normalize();
    const cam = new THREE.PerspectiveCamera(30, 1, radius * 0.05, radius * 20);
    cam.position.copy(center).addScaledVector(dir, (radius * 0.8) / Math.sin((15 * Math.PI) / 180)); // a bounding sphere leaves room; 0.8 fills the frame
    cam.lookAt(center);
    // Render square, then restore the viewport's own size.
    const keep = this.renderer.getSize(new THREE.Vector2());
    const px = Math.min(512, Math.round(size * 2));
    this.renderer.setSize(px, px, false);
    this.renderer.render(this.scene, cam);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#151922';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(this.renderer.domElement, 0, 0, size, size);
    this.renderer.setSize(keep.x, keep.y, false);
    hide.forEach((o, k) => (o.visible = prev[k]));
    this.renderer.render(this.scene, this.camera);
    return c.toDataURL('image/jpeg', 0.82);
  }

  // ------------------------------------------------------------------ loop
  resize() {
    const w = this.el.clientWidth,
      hh = this.el.clientHeight;
    if (!w || !hh) return;
    this.renderer.setSize(w, hh);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }

  advance(dt) {
    const d = app.duration;
    if (d <= 0) return app.setPlaying(false);
    const [a, b] = app.range || [0, d];
    const len = Math.max(1e-4, b - a);
    const speed = app.settings.speed || 1;
    let t = app.time + dt * speed;
    if (t > b + 1e-9) {
      if (app.settings.loopPlayback) t = a + ((t - a) % len);
      else {
        t = b;
        app.setPlaying(false);
      }
    } else if (t < a - 1e-9) {
      if (speed > 0) t = a;
      else if (app.settings.loopPlayback) t = b - ((a - t) % len);
      else {
        t = a;
        app.setPlaying(false);
      }
    }
    app.time = t;
    app.emit('time');
  }

  /** Play a clip on the character without touching the app's clips (Move Maker preview). */
  setPreview(clip, { keepTime = true } = {}) {
    this.preview = clip || null;
    if (!keepTime || !this.previewTime) this.previewTime = 0;
    if (clip) {
      this.gizmo.detach();
      this.previewTime = Math.min(this.previewTime, clip.duration);
    } else {
      this.needsEval = true;
      this.ghostsDirty = true;
      this.attachGizmo();
    }
  }

  tick() {
    requestAnimationFrame(this.tick);
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    if (this.model && this.preview) {
      const c = this.preview;
      if (this.previewPlaying !== false && c.duration > 0) this.previewTime = (this.previewTime + dt * (app.settings.speed || 1)) % c.duration;
      applyPose(c, this.previewTime, this.model.rig);
      this.model.root.updateMatrixWorld(true);
      this.updateOverlay();
      this.orbit.update();
      for (const fn of this.frameHooks) fn();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.model) {
      if (app.playing) this.advance(dt);
      if (this.needsEval && !this.dragging && !this.builder) this.evaluate();
      if (this.ghostsDirty && !this.dragging) this.updateGhosts();
      this.model.root.updateMatrixWorld(true);
      if (!this.builder) this.updateOverlay();
      this.updateTrail();
    }
    this.orbit.update();
    for (const fn of this.frameHooks) fn();
    this.renderer.render(this.scene, this.camera);
  }
}
