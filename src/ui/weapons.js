// Weapons panel: pick a weapon, put it in a hand (or on the back), drag it into place with the
// viewport arrows, and make hold / aim / fire animations with one click. It is a panel on the
// viewport, not a dialog, so the camera, playback and timeline keep working while it is open.
import * as THREE from 'three';
import { app } from '../app/state.js';
import { BUILTIN_PROPS } from '../io/propshapes.js';
import { SOCKETS } from '../io/sockets.js';
import { api } from '../io/api.js';
import { attachProp, updateProp, removeProp, defaultPlacement, resolveSocket } from '../app/props.js';
import { addWeaponSockets } from '../app/session.js';
import { heldProp } from '../app/weaponik.js';
import { weaponKind, weaponActions, makeWeaponClip, holdInClip } from '../app/weaponanim.js';
import { h, toast } from './dom.js';

const DEG = Math.PI / 180;
const ORDER = ['rifle', 'pistol', 'bazooka', 'grenade'];
const PLACES = [
  ['Weapon_R', 'Right hand'],
  ['Weapon_L', 'Left hand'],
  ['Weapon_Back', 'Back'],
];

export class WeaponTool {
  constructor(vp, propView) {
    this.vp = vp;
    this.propView = propView;
    this.active = false;
    this.proxy = new THREE.Object3D();
    this.proxy.name = 'WeaponHandle';
    this.hook = () => this.followProp();
    app.on('props', () => this.active && !this.dragging && this.render());
    app.on('model', () => this.active && (app.model ? this.render() : this.close()));
    app.on('clipSelect', () => this.active && this.render());
  }

  toggle() {
    this.active ? this.close() : this.open();
  }

  open() {
    if (!app.model || this.active) return;
    this.active = true;
    this.panel = h('div', { class: 'wt-panel card' });
    document.getElementById('center').append(this.panel);
    this.onKey = (e) => {
      if (e.key === 'Escape' && !e.target.closest?.('input, select, textarea')) {
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.vp.scene.add(this.proxy);
    this.vp.frameHooks.push(this.hook);
    this.render();
    app.emit('view');
  }

  close() {
    if (!this.active) return;
    this.setHandle(null);
    this.active = false;
    window.removeEventListener('keydown', this.onKey, true);
    this.vp.frameHooks = this.vp.frameHooks.filter((f) => f !== this.hook);
    this.vp.scene.remove(this.proxy);
    this.panel?.remove();
    this.panel = null;
    app.emit('view');
  }

  /** The weapon being worked on: the last one picked, else the one in a hand, else any. */
  current() {
    const props = app.project.props || [];
    return props.find((p) => p.id === this.pid) || props.find((p) => /^Weapon_[RL]$/.test(p.socket) && p.visible !== false) || props[0] || null;
  }

  async pick(kind) {
    try {
      await this.ensureSockets();
      const cur = this.current();
      const builtin = BUILTIN_PROPS[kind];
      // Same hand as the weapon in use; a grenade goes in the free hand of a gun.
      let socket = cur && !/back/i.test(cur.socket) ? cur.socket : null;
      if (kind === 'grenade' && cur && cur.socket === 'Weapon_R' && !/grenade/.test(cur.source)) socket = 'Weapon_L';
      const p = await attachProp({ prop: kind, socket: socket || builtin?.socket || 'Weapon_R' });
      this.pid = p.id;
      this.render();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async ensureSockets() {
    if (!app.rig.humanoid) return;
    if (SOCKETS.every((s) => app.rig.byName.has(s.name))) return;
    await addWeaponSockets();
  }

  async uploadProp() {
    const { pickFile } = await import('../app/dialogs.js');
    const f = await pickFile('.glb');
    if (!f) return;
    try {
      const r = await api.saveProp(f.name, f);
      await this.ensureSockets();
      const p = await attachProp({ prop: r.url, socket: this.current()?.socket });
      this.pid = p.id;
      toast(`${f.name} added to AnimStudio/props`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  moveTo(p, socket) {
    try {
      const s = resolveSocket(socket);
      const place = defaultPlacement(s);
      // Another weapon already there goes away (one per hand).
      const others = (app.project.props || []).filter((x) => x.id !== p.id && x.socket === s);
      for (const o of others) removeProp(o.id);
      updateProp(p.id, { socket: s, pos: place.pos, rot: place.rot });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  reset(p) {
    const place = defaultPlacement(p.socket);
    updateProp(p.id, { pos: place.pos, rot: place.rot, scale: 1 });
  }

  // ------------------------------------------------------------------ arrows on the weapon
  setHandle(mode) {
    const vp = this.vp;
    this.mode = mode;
    if (!mode) {
      if (vp.gizmoOwner === this) {
        vp.gizmo.detach();
        vp.gizmo.setSpace(app.settings.gizmoSpace);
        vp.gizmo.setMode(app.settings.tool === 'move' ? 'translate' : 'rotate');
        vp.gizmoOwner = null;
        vp.attachGizmo();
      }
      return;
    }
    vp.gizmoOwner = this;
    this.followProp(true);
    vp.gizmo.setMode(mode);
    vp.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    vp.gizmo.attach(this.proxy);
  }

  /** Keep the handle on the weapon while the character moves (unless it is being dragged). */
  followProp(force = false) {
    if (!this.active || (this.dragging && !force)) return;
    const p = this.current();
    const obj = p && this.propView.live.get(p.id)?.obj;
    if (!obj || !obj.visible) {
      if (this.vp.gizmoOwner === this && this.vp.gizmo.object) this.vp.gizmo.detach();
      return;
    }
    if (this.vp.gizmoOwner === this && !this.vp.gizmo.object && this.mode) this.vp.gizmo.attach(this.proxy);
    obj.updateMatrixWorld(true);
    obj.matrixWorld.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.updateMatrixWorld(true);
  }

  onGizmo(type) {
    const p = this.current();
    if (!p) return;
    if (type === 'start') {
      this.dragging = true;
      this.vp.orbit.enabled = false;
    } else if (type === 'move') {
      const bi = app.rig.byName.get(p.socket);
      if (bi === undefined) return;
      // New offset in the socket's frame: socket⁻¹ · handle.
      const P = new THREE.Matrix4().compose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
      const L = new THREE.Matrix4().copy(app.rig.bones[bi].matrixWorld).invert().multiply(P);
      const pos = new THREE.Vector3(),
        q = new THREE.Quaternion(),
        s = new THREE.Vector3();
      L.decompose(pos, q, s);
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      p.pos = pos.toArray().map((v) => Math.round(v * 10000) / 10000);
      p.rot = [e.x, e.y, e.z].map((r) => Math.round((r / DEG) * 10) / 10);
    } else if (type === 'end') {
      this.dragging = false;
      this.vp.orbit.enabled = true;
      updateProp(p.id, { pos: p.pos, rot: p.rot }); // saves the project
    }
  }

  // ------------------------------------------------------------------ animations
  async animate(action) {
    const p = this.current();
    if (!p) return;
    await this.run(`Making ${p.name} ${action}…`, async () => {
      const r = await makeWeaponClip(action, { propView: this.propView, prop: p.id });
      this.report(r, `${r.clip.name} created`);
      app.setTime(0);
      app.setPlaying(true);
    });
  }

  async holdHere(aim) {
    const p = this.current();
    const clip = app.committedClip;
    if (!p || !clip) return;
    await this.run(`Putting ${p.name} in ${clip.name}…`, async () => {
      const r = await holdInClip(clip, { propView: this.propView, prop: p.id, aim });
      this.report(r, `${p.name} held ${aim ? 'aimed' : 'low'} in ${clip.name} (layer “Weapon”, arms only — undo with Ctrl+Z)`);
      app.setPlaying(true);
    });
  }

  report(r, msg) {
    const miss = r.out_of_reach?.length ? Math.max(...r.out_of_reach.map((x) => Math.max(x.main_miss_cm || 0, x.support_miss_cm || 0))) : 0;
    if (miss > 5) toast(`${msg}. The arms are a bit short for this grip (up to ${miss.toFixed(0)} cm): move the weapon closer with ✥ Move and make it again.`, '', { ms: 9000 });
    else toast(msg, 'ok');
  }

  async run(status, fn) {
    if (this.busy) return;
    this.busy = true;
    this.panel?.classList.add('busy');
    app.setStatus?.(status);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      toast(e.message, 'err');
    } finally {
      this.busy = false;
      this.panel?.classList.remove('busy');
      app.setStatus?.('');
      this.render();
    }
  }

  // ------------------------------------------------------------------ panel
  async render() {
    if (!this.panel) return;
    const seq = (this.seq = (this.seq || 0) + 1);
    const files = await api.props().catch(() => []);
    if (seq !== this.seq || !this.panel) return;
    const p = this.current();
    if (!p && this.mode) this.setHandle(null);
    const held = p ? await heldProp(this.propView, p.id).catch(() => null) : null;
    if (seq !== this.seq || !this.panel) return;
    const kind = p ? weaponKind(p, !!held?.support) : null;
    const humanoid = app.rig.humanoid;

    const tile = (label, on, onclick, title = '') => h('button', { class: `wt-tile${on ? ' on' : ''}`, title, onclick }, label);
    const weapons = h(
      'div',
      { class: 'wt-tiles' },
      ...ORDER.map((k) => tile(BUILTIN_PROPS[k].label, p?.source === `builtin:${k}`, () => this.pick(k))),
      ...files.map((f) => tile(f.name.replace(/\.glb$/i, ''), p?.source === f.url, () => this.pick(f.name), f.name)),
      tile('＋ .glb…', false, () => this.uploadProp(), 'Use your own weapon model (origin at the grip, +Z towards the muzzle)')
    );

    const sections = [h('div', { class: 'wt-sec' }, h('div', { class: 'wt-h' }, 'Weapon'), weapons)];
    if (p) {
      const where = h(
        'div',
        { class: 'seg' },
        ...PLACES.map(([s, label]) => h('button', { class: p.socket === s ? 'on' : '', onclick: () => p.socket !== s && this.moveTo(p, s) }, label))
      );
      const size = h('input', {
        type: 'range',
        min: 0.3,
        max: 3,
        step: 0.05,
        value: p.scale ?? 1,
        oninput: (e) => {
          p.scale = +e.target.value;
          sizeTxt.textContent = `${p.scale.toFixed(2)}×`;
        },
        onchange: (e) => updateProp(p.id, { scale: +e.target.value }),
      });
      const sizeTxt = h('span', { class: 'muted wt-num' }, `${(p.scale ?? 1).toFixed(2)}×`);
      const handleBtn = (mode, label, title) => h('button', { class: `small${this.mode === mode ? ' on' : ''}`, title, onclick: () => (this.setHandle(this.mode === mode ? null : mode), this.render()) }, label);
      sections.push(
        h('div', { class: 'wt-sec' }, h('div', { class: 'wt-h' }, 'Where'), where),
        h(
          'div',
          { class: 'wt-sec' },
          h('div', { class: 'wt-h' }, 'Fit it in the hand'),
          h('div', { class: 'row', style: { gap: '6px' } }, handleBtn('translate', '✥ Move', 'Drag the arrows on the weapon'), handleBtn('rotate', '⟳ Turn', 'Drag the rings on the weapon'), h('button', { class: 'small', title: 'Back to the starting place and size', onclick: () => this.reset(p) }, 'Reset'), h('div', { class: 'grow' }), h('button', { class: 'small ghost', title: 'Remove this weapon', onclick: () => (removeProp(p.id), (this.pid = null)) }, 'Remove')),
          h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', fontSize: '12px' } }, 'Size', size, sizeTxt),
          this.mode ? h('div', { class: 'muted wt-tip' }, this.mode === 'rotate' ? 'Drag a ring on the weapon to turn it. The camera still turns when you drag elsewhere.' : 'Drag an arrow on the weapon to move it. The camera still turns when you drag elsewhere.') : null
        )
      );
      if (humanoid && !/back/i.test(p.socket)) {
        const clip = app.committedClip;
        const acts = weaponActions(kind).map((a) => h('button', { class: 'wt-act', title: `New clip: ${a.title}`, onclick: () => this.animate(a.id) }, a.label));
        const canHold = clip && !clip.name.startsWith(`${p.name}_`);
        sections.push(
          h(
            'div',
            { class: 'wt-sec' },
            h('div', { class: 'wt-h' }, 'Make an animation'),
            h('div', { class: 'wt-acts' }, ...acts),
            canHold
              ? h(
                  'div',
                  { class: 'col', style: { gap: '4px' } },
                  h('div', { class: 'muted', style: { fontSize: '12px' } }, `Or keep the legs of “${clip.name}” and hold the ${p.name.toLowerCase()} in it:`),
                  h('div', { class: 'row', style: { gap: '6px' } }, h('button', { class: 'small grow', onclick: () => this.holdHere(false) }, 'Hold low'), kind !== 'grenade' ? h('button', { class: 'small grow', onclick: () => this.holdHere(true) }, 'Aim') : null)
                )
              : null
          )
        );
      } else if (!humanoid) sections.push(h('div', { class: 'muted wt-tip' }, 'Animations need a humanoid skeleton: Tools › Build skeleton.'));
    } else sections.push(h('div', { class: 'muted wt-tip' }, 'Pick a weapon: it goes in the right hand. Then make Hold, Aim or Fire animations, or hold it in a walk.'));
    sections.push(h('div', { class: 'muted wt-foot' }, 'Preview only: in your game, attach your weapon model to the same socket (Weapon_R, Weapon_L, Weapon_Back).'));

    this.panel.replaceChildren(h('div', { class: 'row' }, h('b', { class: 'grow' }, 'Weapons'), h('button', { class: 'ghost icon', title: 'Close (Esc)', onclick: () => this.close() }, '✕')), ...sections);
  }
}
