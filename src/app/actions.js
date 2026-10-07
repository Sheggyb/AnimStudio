// Editing actions shared by the viewport, panels, dope sheet and commands.
import * as THREE from 'three';
import { app } from './state.js';
import { keyBone } from '../core/keying.js';
import { evalBone, makeXform } from '../core/evaluate.js';
import { findKey, setKey, removeKeys, retimeKeys, STRIDE, KEY_EPS } from '../core/channel.js';
import { pruneLayer, TYPES, getTrack } from '../core/clip.js';
import { mirrorLocalRot, mirrorLocalPos, mirrorIndex } from '../core/rig.js';
import { toast } from '../ui/dom.js';

export const timeKey = (t) => Math.round(t * 1e4);
export const keyId = (bone, t) => `${bone}|${timeKey(t)}`;
export function parseKeyId(id) {
  const k = id.lastIndexOf('|');
  return { bone: id.slice(0, k), t: +id.slice(k + 1) / 1e4 };
}

// Hook set by the viewport so actions can ask for a re-evaluation of the pose.
export const hooks = { refreshPose: () => {}, posePreview: () => {}, thumbnail: () => null };

function need({ clip = true, bones = null } = {}) {
  if (!app.model) {
    toast('Load a model first', 'err');
    return false;
  }
  if (clip && !app.clip) {
    toast('Select or create a clip first', 'err');
    return false;
  }
  if (bones && !bones.length) {
    toast('Select a bone first (click a joint)', 'err');
    return false;
  }
  return true;
}

export const selectedBones = () => [...app.sel.bones];

const liveTarget = (i) => {
  const b = app.rig.bones[i];
  return { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() };
};

/** Key bones at the playhead from their current (on-screen) transforms. */
export function keyBones(indices = selectedBones(), { label = 'Set key', which = null, t = app.time } = {}) {
  if (!need({ bones: indices })) return;
  const rig = app.rig;
  const li = app.layerIndex;
  const L = app.layer;
  if (L.mute) toast(`Layer "${L.name}" is muted — the key won't be visible until you unmute it`);
  const targets = indices.map((i) => ({ i, ...liveTarget(i) }));
  app.edit(label, (clip) => {
    let ok = true;
    for (const x of targets) ok = keyBone(clip, li, rig.names[x.i], t, x, rig.rest[x.i], which || { rot: true, pos: 'auto', scl: 'auto' }, app.settings.interp) && ok;
    if (!ok) toast('Layer weight is 0 — raise it to key on this layer', 'err');
  });
}

export function keyAll() {
  if (!need()) return;
  keyBones(
    app.rig.bones.map((_, i) => i).filter((i) => app.rig.group[i] !== 'attach'),
    { label: 'Key all bones' }
  );
}

/** Delete keys at the playhead for bones (active layer). */
export function deleteKeysAtTime(indices = selectedBones(), t = app.time) {
  if (!need({ bones: indices })) return;
  const names = indices.map((i) => app.rig.names[i]);
  let n = 0;
  const L0 = app.layer;
  for (const b of names) for (const k of TYPES) if (L0.tracks[b]?.[k] && findKey(L0.tracks[b][k], t, 0.45 / app.fps) >= 0) n++;
  if (!n) return toast('No key on the selected bones at this frame');
  app.edit('Delete key', (clip) => {
    const L = clip.layers[app.layerIndex];
    for (const b of names)
      for (const k of TYPES) {
        const ch = L.tracks[b]?.[k];
        if (!ch) continue;
        const i = findKey(ch, t, 0.45 / app.fps);
        if (i >= 0) removeKeys(ch, [i]);
      }
    pruneLayer(L);
  });
}

/** Put bones back to the rest pose (and key it when auto-key is on). */
export function resetToRest(indices = selectedBones()) {
  if (!need({ clip: false, bones: indices })) return;
  for (const i of indices) {
    const r = app.rig.rest[i];
    const b = app.rig.bones[i];
    b.position.copy(r.p);
    b.quaternion.copy(r.q);
    b.scale.copy(r.s);
  }
  afterManualPose(indices, 'Reset to rest');
}

/** After the user changed bone transforms directly: key (auto-key) or flag as unkeyed. */
export function afterManualPose(indices, label = 'Pose') {
  if (app.settings.autoKey && app.clip) keyBones(indices, { label });
  else hooks.posePreview(indices);
}

// ---------------------------------------------------------------------------
// Pose clipboard & mirroring
// ---------------------------------------------------------------------------
let poseClipboard = null;

export function capturePose(indices) {
  const rig = app.rig;
  const bones = {};
  for (const i of indices) {
    const b = rig.bones[i];
    bones[rig.names[i]] = { p: b.position.toArray(), q: b.quaternion.toArray(), s: b.scale.toArray() };
  }
  return bones;
}

export function copyPose(indices = null) {
  if (!need({ clip: false })) return;
  const rig = app.rig;
  const list = indices && indices.length ? indices : rig.bones.map((_, i) => i).filter((i) => rig.group[i] !== 'attach');
  poseClipboard = capturePose(list);
  toast(`Copied pose (${list.length} bones)`);
}

/** Apply a stored pose ({name: {p,q,s}}) to the live skeleton and key it. */
export function applyPoseData(bones, { mirror = false, only = null, blend = 1, label = 'Paste pose' } = {}) {
  if (!need()) return;
  const rig = app.rig;
  const touched = [];
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (const [name, v] of Object.entries(bones)) {
    let i = rig.byName.get(name);
    if (i === undefined) continue;
    q.fromArray(v.q);
    p.fromArray(v.p);
    if (mirror) {
      const j = mirrorIndex(rig, i);
      mirrorLocalRot(rig, i, q, q);
      mirrorLocalPos(rig, i, p, p);
      i = j;
    }
    if (only && !only.has(i)) continue;
    const b = rig.bones[i];
    b.quaternion.slerp(q, blend);
    b.position.lerp(p, blend);
    if (v.s) b.scale.lerp(new THREE.Vector3().fromArray(v.s), blend);
    touched.push(i);
  }
  if (!touched.length) return toast('Nothing to paste for these bones', 'err');
  keyBones(touched, { label });
}

export function pastePose({ mirror = false } = {}) {
  if (!poseClipboard) return toast('Copy a pose first (Ctrl+Shift+C)', 'err');
  const only = app.sel.bones.size ? new Set(app.sel.bones) : null;
  applyPoseData(poseClipboard, { mirror, only, label: mirror ? 'Paste mirrored pose' : 'Paste pose' });
}

/** Copy the selected bones' pose onto their mirror partners. */
export function mirrorToOtherSide(indices = selectedBones()) {
  if (!need({ bones: indices })) return;
  const rig = app.rig;
  const data = capturePose(indices.filter((i) => rig.mirror[i] >= 0));
  if (!Object.keys(data).length) return toast('Selected bones have no left/right partner', 'err');
  applyPoseData(data, { mirror: true, label: 'Mirror pose' });
}

/** Mirror the whole body pose (left becomes right) at the playhead. */
export function flipPose() {
  if (!need()) return;
  const rig = app.rig;
  const all = rig.bones.map((_, i) => i).filter((i) => rig.group[i] !== 'attach');
  applyPoseData(capturePose(all), { mirror: true, label: 'Flip pose' });
}

// ---------------------------------------------------------------------------
// Key selection (dope sheet / graph)
// ---------------------------------------------------------------------------
export function forEachSelectedKey(layer, fn, sel = app.keySel) {
  for (const id of sel) {
    const { bone, t } = parseKeyId(id);
    const tr = layer.tracks[bone];
    if (!tr) continue;
    for (const type of TYPES) {
      const ch = tr[type];
      if (!ch) continue;
      const i = findKey(ch, t, 2e-4);
      if (i >= 0) fn(ch, i, bone, type, t);
    }
  }
}

/** Re-time the selected keys inside `clip` (a draft). Returns the new selection set. */
export function retimeSelection(clip, layerIndex, sel, mapT) {
  const L = clip.layers[layerIndex];
  const byBone = new Map();
  for (const id of sel) {
    const { bone, t } = parseKeyId(id);
    if (!byBone.has(bone)) byBone.set(bone, []);
    byBone.get(bone).push(t);
  }
  const next = new Set();
  const clampT = (t) => Math.min(clip.duration, Math.max(0, t));
  for (const [bone, times] of byBone) {
    const tr = L.tracks[bone];
    if (!tr) continue;
    for (const type of TYPES) {
      const ch = tr[type];
      if (!ch) continue;
      const idx = times.map((t) => findKey(ch, t, 2e-4)).filter((i) => i >= 0);
      if (idx.length) retimeKeys(ch, idx, (t) => clampT(mapT(t)));
    }
    for (const t of times) next.add(keyId(bone, clampT(mapT(t))));
  }
  return next;
}

export function deleteSelectedKeys() {
  if (!app.clip || !app.keySel.size) return toast('No keys selected');
  const sel = new Set(app.keySel);
  app.edit('Delete keys', (clip) => {
    const L = clip.layers[app.layerIndex];
    const perCh = new Map();
    forEachSelectedKey(L, (ch, i) => {
      if (!perCh.has(ch)) perCh.set(ch, []);
      perCh.get(ch).push(i);
    }, sel);
    for (const [ch, idx] of perCh) removeKeys(ch, idx);
    pruneLayer(L);
  });
  app.keySel.clear();
  app.emit('keySel');
}

export function setSelectedInterp(mode) {
  if (!app.clip) return;
  const sel = app.keySel.size ? new Set(app.keySel) : null;
  app.edit('Set interpolation', (clip) => {
    const L = clip.layers[app.layerIndex];
    if (sel) forEachSelectedKey(L, (ch, i) => (ch.interp[i] = mode), sel);
    else {
      // No key selection: apply to the selected bones' keys (or everything) in the range.
      const bones = app.sel.bones.size ? new Set([...app.sel.bones].map((i) => app.rig.names[i])) : null;
      const [a, b] = app.range || [0, clip.duration];
      for (const bone in L.tracks) {
        if (bones && !bones.has(bone)) continue;
        for (const k of TYPES) {
          const ch = L.tracks[bone][k];
          if (!ch) continue;
          for (let i = 0; i < ch.times.length; i++) if (ch.times[i] >= a - KEY_EPS && ch.times[i] <= b + KEY_EPS) ch.interp[i] = mode;
        }
      }
    }
  });
}

let keyClipboard = null;
export function copyKeys() {
  if (!app.clip || !app.keySel.size) return toast('Select keys in the dope sheet first');
  const L = app.layer;
  const items = [];
  forEachSelectedKey(L, (ch, i, bone, type, t) => {
    const s = STRIDE[type];
    items.push({ bone, type, t, v: Array.from(ch.values.subarray(i * s, (i + 1) * s)), interp: ch.interp[i] });
  });
  const t0 = Math.min(...items.map((x) => x.t));
  keyClipboard = items.map((x) => ({ ...x, dt: x.t - t0 }));
  toast(`Copied ${app.keySel.size} keys`);
}

export function pasteKeys({ mirror = false } = {}) {
  if (!keyClipboard) return toast('Copy keys first');
  if (!app.clip) return;
  const rig = app.rig;
  const t0 = app.time;
  const next = new Set();
  app.edit(mirror ? 'Paste keys mirrored' : 'Paste keys', (clip) => {
    const L = clip.layers[app.layerIndex];
    const additive = L.mode === 'additive';
    for (const k of keyClipboard) {
      let bone = k.bone;
      let v = k.v;
      const i = rig.byName.get(bone);
      if (i === undefined) continue;
      if (mirror) {
        const j = mirrorIndex(rig, i);
        if (k.type === 'rot') v = mirrorLocalRot(rig, i, new THREE.Quaternion().fromArray(v), new THREE.Quaternion(), additive).toArray();
        else if (k.type === 'pos') v = mirrorLocalPos(rig, i, new THREE.Vector3().fromArray(v), new THREE.Vector3(), additive).toArray();
        bone = rig.names[j];
      }
      const t = Math.min(clip.duration, t0 + k.dt);
      setKey(getTrack(L, bone, k.type, true), t, v, k.interp);
      next.add(keyId(bone, t));
    }
  });
  app.keySel = next;
  app.emit('keySel');
}

/** Select every key of the given bones (or all) in the active layer, optionally within the range. */
export function selectKeys({ bones = null, range = app.range, add = false } = {}) {
  const L = app.layer;
  if (!L) return;
  const sel = add ? new Set(app.keySel) : new Set();
  const [a, b] = range || [-Infinity, Infinity];
  for (const bone in L.tracks) {
    if (bones && !bones.has(bone)) continue;
    for (const k of TYPES) {
      const ch = L.tracks[bone][k];
      if (!ch) continue;
      for (const t of ch.times) if (t >= a - KEY_EPS && t <= b + KEY_EPS) sel.add(keyId(bone, t));
    }
  }
  app.keySel = sel;
  app.emit('keySel');
}

/** Sorted key times for navigation: selected bones in the active layer, else all. */
export function navKeyTimes() {
  const L = app.layer;
  if (!L) return [];
  const bones = app.sel.bones.size ? new Set([...app.sel.bones].map((i) => app.rig.names[i])) : null;
  const set = new Set();
  for (const bone in L.tracks) {
    if (bones && !bones.has(bone)) continue;
    for (const k of TYPES) L.tracks[bone][k]?.times.forEach((t) => set.add(timeKey(t)));
  }
  return [...set].sort((a, b) => a - b).map((x) => x / 1e4);
}

export function jumpKey(dir) {
  const times = navKeyTimes();
  const eps = 0.45 / app.fps;
  const t = dir > 0 ? times.find((x) => x > app.time + eps) : [...times].reverse().find((x) => x < app.time - eps);
  if (t !== undefined) {
    app.setPlaying(false);
    app.setTime(t);
  }
}

/** Evaluate the clip's value of a bone at the playhead (ignores unkeyed edits). */
export function evaluatedLocal(i, t = app.time) {
  return evalBone(app.clip, app.rig.names[i], t, app.rig.rest[i], makeXform());
}
