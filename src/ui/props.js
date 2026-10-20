// Viewport display of attached props (the Weapons panel is ui/weapons.js).
import * as THREE from 'three';
import { app } from '../app/state.js';
import { readGLTF } from '../io/loader.js';
import { makeBuiltinProp } from '../io/propshapes.js';
import { toast } from './dom.js';

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
