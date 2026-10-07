// Viewport display of attached props, and the "Weapons & props" dialog.
import * as THREE from 'three';
import { app } from '../app/state.js';
import { readGLTF } from '../io/loader.js';
import { makeBuiltinProp, BUILTIN_PROPS } from '../io/propshapes.js';
import { SOCKETS } from '../io/sockets.js';
import { api } from '../io/api.js';
import { attachProp, updateProp, removeProp } from '../app/props.js';
import { addWeaponSockets } from '../app/session.js';
import { openModal } from './dialog.js';
import { h, toast } from './dom.js';

const DEG = Math.PI / 180;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

const fileCache = new Map();
async function loadPropObject(source, height) {
  if (source.startsWith('builtin:')) return makeBuiltinProp(source.slice(8), height);
  if (!fileCache.has(source)) fileCache.set(source, readGLTF(source));
  const gltf = await fileCache.get(source);
  const obj = gltf.scene.clone(true);
  obj.traverse((o) => o.isMesh && (o.castShadow = true));
  return obj;
}

/** Keeps one object per prop in the scene, following its socket bone every frame. */
export class PropView {
  constructor(vp) {
    this.vp = vp;
    this.group = new THREE.Group();
    this.group.name = 'Props';
    vp.scene.add(this.group);
    this.live = new Map(); // id -> { source, obj }
    app.on('props', () => this.sync());
    app.on('model', () => this.sync(true));
    vp.frameHooks.push(() => this.update());
  }

  async sync(rebuild = false) {
    const props = app.model ? app.project.props || [] : [];
    for (const [id, e] of this.live) {
      const p = props.find((x) => x.id === id);
      if (rebuild || !p || p.source !== e.source) {
        this.group.remove(e.obj);
        this.live.delete(id);
      }
    }
    for (const p of props) {
      if (this.live.has(p.id)) continue;
      const entry = { source: p.source, obj: new THREE.Group() };
      entry.obj.matrixAutoUpdate = false;
      this.live.set(p.id, entry);
      this.group.add(entry.obj);
      try {
        entry.obj.add(await loadPropObject(p.source, app.rig.height));
      } catch (e) {
        console.warn(e);
        toast(`Could not load prop ${p.name}: ${e.message}`, 'err');
      }
    }
  }

  update() {
    const rig = app.rig;
    if (!rig) return;
    for (const p of app.project.props || []) {
      const e = this.live.get(p.id);
      if (!e) continue;
      const bi = rig.byName.get(p.socket);
      e.obj.visible = p.visible !== false && bi !== undefined && app.settings.showMesh !== false;
      if (!e.obj.visible) continue;
      _e.set(...(p.rot || [0, 0, 0]).map((d) => d * DEG));
      _m.compose(_p.fromArray(p.pos || [0, 0, 0]), _q.setFromEuler(_e), _s.setScalar(p.scale ?? 1));
      e.obj.matrix.multiplyMatrices(rig.bones[bi].matrixWorld, _m);
      e.obj.matrixWorldNeedsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
export async function propsDialog() {
  if (!app.model) return;
  const body = h('div', { class: 'col', style: { gap: '10px', minWidth: '520px' } });
  const modal = openModal({ title: 'Weapons & props', body, wide: true, buttons: [{ label: 'Done', primary: true, value: null }] });
  const off = app.on('props', () => render());

  async function render() {
    const rig = app.rig;
    const missing = SOCKETS.filter((s) => !rig.byName.has(s.name));
    const files = await api.props().catch(() => []);
    const sockets = [...SOCKETS.filter((s) => rig.byName.has(s.name)).map((s) => [s.name, `${s.label} (${s.name})`]), ...['hand.R', 'hand.L', 'chest', 'head', 'hips'].filter((k) => rig.byKind.has(k)).map((k) => [rig.names[rig.byKind.get(k)], `${rig.labels[rig.byKind.get(k)]} bone`])];
    const rows = (app.project.props || []).map((p) => {
      const num = (k, idx, step, scale = 1) =>
        h('input', {
          type: 'number',
          step,
          value: +((p[k]?.[idx] ?? 0) * scale).toFixed(2),
          style: { width: '64px' },
          onchange: (e) => {
            const v = [...(p[k] || [0, 0, 0])];
            v[idx] = +e.target.value / scale;
            updateProp(p.id, { [k]: v });
          },
        });
      const sel = h('select', { onchange: (e) => updateProp(p.id, { socket: e.target.value }) }, sockets.map(([v, l]) => h('option', { value: v, selected: v === p.socket }, l)));
      if (!sockets.some(([v]) => v === p.socket)) sel.append(h('option', { value: p.socket, selected: true }, p.socket));
      return h(
        'div',
        { class: 'card', style: { padding: '8px 10px', display: 'grid', gap: '6px' } },
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: p.visible !== false, title: 'Visible', onchange: (e) => updateProp(p.id, { visible: e.target.checked }) }), h('b', { class: 'grow' }, p.name), sel, h('button', { class: 'small danger', onclick: () => removeProp(p.id) }, 'Remove')),
        h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', fontSize: '12px' } }, 'Move (cm)', num('pos', 0, 0.5, 100), num('pos', 1, 0.5, 100), num('pos', 2, 0.5, 100), 'Rotate (°)', num('rot', 0, 5), num('rot', 1, 5), num('rot', 2, 5), 'Scale', h('input', { type: 'number', step: 0.05, value: p.scale ?? 1, style: { width: '58px' }, onchange: (e) => updateProp(p.id, { scale: +e.target.value }) }))
      );
    });
    const addBtn = (label, prop) => h('button', { class: 'small', onclick: () => attachProp({ prop }).catch((e) => toast(e.message, 'err')) }, label);
    body.replaceChildren(
      missing.length
        ? h('div', { class: 'card', style: { padding: '8px 10px' } }, h('div', {}, `This character has no ${missing.map((s) => s.name).join(', ')} socket(s) yet. Sockets are bones your game engine attaches weapons to.`), h('button', { class: 'primary small', style: { marginTop: '6px' }, onclick: () => addWeaponSockets().catch((e) => toast(e.message, 'err')) }, 'Add weapon sockets'))
        : h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Sockets: Weapon_R (right palm), Weapon_L (left palm), Weapon_Back (holster). Props are a preview only — they are not exported with the character; attach your weapon models to the same sockets in the game.'),
      ...(rows.length ? rows : [h('div', { class: 'muted' }, 'No props attached.')]),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, 'Attach:', ...Object.entries(BUILTIN_PROPS).map(([k, d]) => addBtn(d.label, k)), ...files.map((f) => addBtn(f.name.replace(/\.glb$/i, ''), f.name)), h('button', { class: 'small', onclick: uploadProp }, 'From .glb file…'))
    );
  }

  async function uploadProp() {
    const { pickFile } = await import('../app/dialogs.js');
    const f = await pickFile('.glb');
    if (!f) return;
    const r = await api.saveProp(f.name, f);
    await attachProp({ prop: r.url });
    toast(`${f.name} added to AnimStudio/props`, 'ok');
  }

  await render();
  await modal.result;
  off?.();
}
