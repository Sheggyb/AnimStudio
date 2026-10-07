// Central application state + event hub.
//
// Clips are copy-on-write: `edit()` clones the current clip, mutates the clone and swaps it
// into a new clips array, so every history entry is just a set of array/object references.
import { History } from '../core/history.js';
import { cloneClip } from '../core/clip.js';
import { SMOOTH } from '../core/channel.js';

const SETTINGS_KEY = 'animstudio.settings.v1';
export const DEFAULT_SETTINGS = {
  fps: 30,
  interp: SMOOTH,
  autoKey: true,
  onion: false,
  onionBefore: 2,
  onionAfter: 2,
  onionStep: 3,
  trail: false,
  showAllBones: false,
  showSkeleton: true,
  showJoints: true,
  showMesh: true,
  weightView: false,
  jointScale: 1,
  gizmoSize: 0.85,
  gizmoSpace: 'local',
  tool: 'rotate',
  lockFeet: false,
  speed: 1,
  loopPlayback: true,
  autosaveSec: 45,
  alphaCut: false,
  shadows: true,
  bottomTab: 'dope',
  rightTab: 'pose',
  bottomH: 280,
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class Emitter {
  constructor() {
    this._handlers = new Map();
  }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }
  emit(type, data) {
    const hs = this._handlers.get(type);
    if (hs)
      for (const fn of [...hs]) {
        try {
          fn(data);
        } catch (e) {
          console.error(`[${type}]`, e);
        }
      }
  }
}

class App extends Emitter {
  constructor() {
    super();
    this.model = null; // see io/loader.js
    this.rig = null;
    this.clips = [];
    this.originals = new Map(); // originalName -> pristine clip
    this.excluded = new Set(); // clip ids not checked for export
    this.clipId = null;
    this.layerId = null;
    this.time = 0;
    this.playing = false;
    this.range = null; // [t0, t1]
    this.sel = { bones: new Set(), active: -1 };
    this.keySel = new Set(); // "boneName|timeKey"
    this.live = null; // { clipId, base, clip, label }
    this.history = new History(250);
    this.project = { name: null, dirty: false, nick: {}, poses: [], props: [], savedAt: null };
    this.settings = loadSettings();
    this.version = 0;
    this.compareClipId = null; // ghost reference clip
    this.keyPoses = null; // analysis markers {clipId, times}
    this.status = '';
  }

  // ------------------------------------------------------------------ getters
  get clip() {
    if (this.live && this.live.clipId === this.clipId) return this.live.clip;
    return this.clips.find((c) => c.id === this.clipId) || null;
  }
  get committedClip() {
    return this.clips.find((c) => c.id === this.clipId) || null;
  }
  clipById(id) {
    if (this.live && this.live.clipId === id) return this.live.clip;
    return this.clips.find((c) => c.id === id) || null;
  }
  get layerIndex() {
    const c = this.clip;
    if (!c) return 0;
    const i = c.layers.findIndex((l) => l.id === this.layerId);
    return i < 0 ? 0 : i;
  }
  get layer() {
    return this.clip?.layers[this.layerIndex] || null;
  }
  get duration() {
    return this.clip?.duration || 0;
  }
  get fps() {
    return this.settings.fps;
  }
  get nick() {
    return this.project.nick;
  }
  get activeBone() {
    return this.sel.active;
  }

  // ------------------------------------------------------------------ settings
  set(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {}
    this.emit('settings', key);
  }

  // ------------------------------------------------------------------ model / project
  setModel(model, clips) {
    this.cancelLive();
    this.model = model;
    this.rig = model?.rig || null;
    this.clips = clips || [];
    this.originals = new Map(this.clips.filter((c) => c.meta.original).map((c) => [c.meta.originalName, c]));
    this.excluded = new Set();
    this.history.clear();
    this.sel = { bones: new Set(), active: -1 };
    this.keySel.clear();
    this.range = null;
    this.time = 0;
    this.playing = false;
    this.compareClipId = null;
    this.keyPoses = null;
    this.project = { name: null, dirty: false, nick: this.project.nick && model ? loadNick(model.name) : {}, poses: [], props: [], savedAt: null };
    this.version++;
    const first = this.clips.find((c) => c.duration > 0) || this.clips[0];
    this.clipId = first?.id || null;
    this.layerId = first?.layers[0].id || null;
    this.emit('model');
    this.emit('clips');
    this.emit('clipSelect');
    this.emit('selection');
    this.emit('project');
    this.emit('props');
  }

  /** Same character, new model record (e.g. sockets added): keeps clips, history and project. */
  replaceModel(model) {
    this.cancelLive();
    this.model = model;
    this.rig = model.rig;
    this.sel = { bones: new Set(), active: -1 };
    this.version++;
    this.emit('model');
    this.emit('selection');
    this.emit('clip', {});
    this.markDirty();
  }

  /** Props (weapons…) attached to sockets; part of the project. */
  setProps(props, label = 'Props') {
    this.project.props = props;
    this.markDirty();
    this.emit('props', label);
  }

  markDirty() {
    this.version++;
    if (!this.project.dirty) {
      this.project.dirty = true;
      this.emit('project');
    }
  }

  setNick(boneName, nick) {
    if (nick) this.project.nick[boneName] = nick;
    else delete this.project.nick[boneName];
    saveNick(this.model?.name, this.project.nick);
    this.markDirty();
    this.emit('rigNames');
  }

  // ------------------------------------------------------------------ clips
  selectClip(id, { keepTime = false } = {}) {
    if (this.live) this.cancelLive();
    const c = this.clips.find((x) => x.id === id);
    if (!c) return;
    const changed = id !== this.clipId;
    this.clipId = id;
    if (!c.layers.some((l) => l.id === this.layerId)) this.layerId = c.layers[0].id;
    if (changed) {
      this.keySel.clear();
      this.range = null;
      if (!keepTime) this.time = 0;
      this.time = Math.min(this.time, c.duration);
    }
    this.emit('clipSelect');
    this.emit('time');
  }

  setLayer(id) {
    this.layerId = id;
    this.keySel.clear();
    this.emit('layer');
    this.emit('keySel');
  }

  isExported(id) {
    return !this.excluded.has(id);
  }
  setExported(id, on) {
    if (on) this.excluded.delete(id);
    else this.excluded.add(id);
    this.markDirty();
    this.emit('clips');
  }

  // ------------------------------------------------------------------ time
  snap(t) {
    return Math.round(t * this.fps) / this.fps;
  }
  setTime(t, { snap = false } = {}) {
    const d = this.duration;
    let v = Math.min(Math.max(0, snap ? this.snap(t) : t), d);
    if (!Number.isFinite(v)) v = 0;
    if (v === this.time) return;
    this.time = v;
    this.emit('time');
  }
  setPlaying(p) {
    p = !!p && this.duration > 0;
    if (p === this.playing) return;
    this.playing = p;
    if (!p) this.setTime(this.snap(this.time));
    this.emit('play');
  }
  setRange(r) {
    if (r) {
      const a = Math.max(0, Math.min(r[0], r[1]));
      const b = Math.min(this.duration, Math.max(r[0], r[1]));
      this.range = b - a > 1e-4 ? [a, b] : null;
    } else this.range = null;
    this.emit('range');
  }

  // ------------------------------------------------------------------ bone selection
  selectBones(indices, { mode = 'replace', active } = {}) {
    const set = mode === 'replace' ? new Set() : new Set(this.sel.bones);
    for (const i of indices) {
      if (i < 0) continue;
      if (mode === 'toggle' && set.has(i)) set.delete(i);
      else set.add(i);
    }
    let act = active ?? (indices.length ? indices[indices.length - 1] : -1);
    if (!set.has(act)) act = set.size ? [...set][set.size - 1] : -1;
    this.sel = { bones: set, active: act };
    this.emit('selection');
  }
  clearBones() {
    this.sel = { bones: new Set(), active: -1 };
    this.emit('selection');
  }

  // ------------------------------------------------------------------ editing & history
  snapshot() {
    return {
      clips: this.clips,
      clipId: this.clipId,
      layerId: this.layerId,
      excluded: new Set(this.excluded),
      poses: this.project.poses,
    };
  }
  restore(s) {
    this.cancelLive();
    this.clips = s.clips;
    this.excluded = new Set(s.excluded);
    this.project.poses = s.poses;
    const sameClip = s.clipId === this.clipId;
    this.clipId = s.clipId && this.clips.some((c) => c.id === s.clipId) ? s.clipId : this.clips[0]?.id || null;
    const c = this.committedClip;
    this.layerId = c?.layers.some((l) => l.id === s.layerId) ? s.layerId : c?.layers[0].id || null;
    if (c) this.time = Math.min(this.time, c.duration);
    this.keySel.clear();
    this.markDirty();
    this.emit('clips');
    if (!sameClip) this.emit('clipSelect');
    this.emit('clip', {});
    this.emit('poses');
    this.emit('history');
  }

  /** Edit one clip (copy-on-write). fn(draft) may return false to abort, or a message. */
  edit(label, fn, { clipId = this.clipId } = {}) {
    if (this.live) this.cancelLive();
    const idx = this.clips.findIndex((c) => c.id === clipId);
    if (idx < 0) return undefined;
    const draft = cloneClip(this.clips[idx]);
    const r = fn(draft);
    if (r === false) return false;
    this.history.push(label, this.snapshot());
    const clips = this.clips.slice();
    clips[idx] = draft;
    this.clips = clips;
    if (clipId === this.clipId && !draft.layers.some((l) => l.id === this.layerId)) this.layerId = draft.layers[0].id;
    this.markDirty();
    this.emit('clip', { clipId });
    this.emit('clips');
    this.emit('history');
    return r;
  }

  /** Structural edit of the clip list. fn(clipsCopy) mutates the copy (or returns a new array). */
  editClips(label, fn) {
    if (this.live) this.cancelLive();
    const copy = this.clips.slice();
    const before = this.snapshot();
    const r = fn(copy);
    if (r === false) return false;
    this.history.push(label, before);
    this.clips = Array.isArray(r) ? r : copy;
    if (!this.clips.some((c) => c.id === this.clipId)) {
      this.clipId = this.clips[0]?.id || null;
      this.layerId = this.clips[0]?.layers[0].id || null;
      this.emit('clipSelect');
    }
    this.markDirty();
    this.emit('clips');
    this.emit('clip', {});
    this.emit('history');
    return r;
  }

  /** Add a new clip after the current one and select it. */
  addClip(clip, label = 'Add clip', { select = true } = {}) {
    const used = new Set(this.clips.map((c) => c.name));
    let name = clip.name || 'Clip',
      k = 2;
    const base = name.replace(/_\d+$/, '');
    while (used.has(name)) name = `${base}_${k++}`;
    clip.name = name;
    this.editClips(label, (arr) => {
      const at = arr.findIndex((c) => c.id === this.clipId);
      arr.splice(at < 0 ? arr.length : at + 1, 0, clip);
    });
    if (select) this.selectClip(clip.id);
    return clip;
  }

  updatePoses(label, fn) {
    this.history.push(label, this.snapshot());
    this.project.poses = fn(this.project.poses.slice());
    this.markDirty();
    this.emit('poses');
    this.emit('history');
  }

  // Live preview: show a modified copy of the current clip without committing.
  beginLive(label = 'Edit') {
    const base = this.committedClip;
    if (!base) return null;
    this.live = { clipId: base.id, base, clip: cloneClip(base), label };
    return this.live.clip;
  }
  updateLive(fn) {
    if (!this.live) return;
    const draft = cloneClip(this.live.base);
    try {
      fn(draft);
    } catch (e) {
      console.error(e);
    }
    this.live.clip = draft;
    this.version++;
    this.emit('clip', { live: true });
  }
  commitLive(label) {
    if (!this.live) return;
    const { clipId, clip } = this.live;
    this.live = null;
    const idx = this.clips.findIndex((c) => c.id === clipId);
    if (idx < 0) return;
    this.history.push(label || 'Edit', this.snapshot());
    const clips = this.clips.slice();
    clips[idx] = clip;
    this.clips = clips;
    this.markDirty();
    this.emit('clip', { clipId });
    this.emit('clips');
    this.emit('history');
  }
  cancelLive() {
    if (!this.live) return;
    this.live = null;
    this.version++;
    this.emit('clip', { live: false });
  }

  undo() {
    const e = this.history.undo(this.snapshot());
    if (!e) return null;
    this.restore(e.snapshot);
    return e.label;
  }
  redo() {
    const e = this.history.redo(this.snapshot());
    if (!e) return null;
    this.restore(e.snapshot);
    return e.label;
  }

  setStatus(msg) {
    this.status = msg;
    this.emit('status', msg);
  }
}

function loadNick(model) {
  try {
    return JSON.parse(localStorage.getItem('animstudio.nick.' + model) || '{}');
  } catch {
    return {};
  }
}
function saveNick(model, nick) {
  if (!model) return;
  try {
    localStorage.setItem('animstudio.nick.' + model, JSON.stringify(nick));
  } catch {}
}

export const app = new App();
window.__app = app; // handy for debugging in the console
