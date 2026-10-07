// Live bridge (browser side): receives tool calls from the AnimStudio server (MCP / scripts),
// runs them in this tab — so the user sees every change happen — and posts results back.
import * as THREE from 'three';
import { app } from './state.js';
import { api } from '../io/api.js';
import * as cmds from './commands.js';
import { openModel, saveProject, autosaveNow, saveRiggedModel, addWeaponSockets, openProjectByName } from './session.js';
import { attachProp, updateProp, removeProp } from './props.js';
import { BUILTIN_PROPS } from '../io/propshapes.js';
import { SOCKETS } from '../io/sockets.js';
import { OPS, resolveBones } from './oprunner.js';
import { makeClip, makeLayer, cloneClip, getTrack, pruneLayer, TYPES, clipKeyCount } from '../core/clip.js';
import { findKey, removeKeys, SMOOTH, LINEAR, EASE, STEP } from '../core/channel.js';
import { evalBone, makeXform } from '../core/evaluate.js';
import { keyWeaponPoses, keySupportHand, solveLimbTargets } from './weaponik.js';
import { applyPose } from '../core/evaluate.js';
import { keyBone } from '../core/keying.js';
import { anatomicalLocal, bodyOffsetLocal, resolveBone, controllableBones, bodyAxes } from '../core/anatomy.js';
import { generateMotion, GAITS, MOTION_TYPES } from '../core/gait.js';
import { applyStyle, STYLE_DEFAULTS } from '../core/style.js';
import { buildCatalog, CATEGORIES } from '../core/movecatalog.js';
import { retargetClip } from '../core/retarget.js';
import { loadAnimSource } from '../io/animsource.js';
import { listLibrary, loadMove, saveMove, buildStandardMove, moveOnCharacter, standardRig } from '../io/library.js';
import { exportGLB } from '../io/exporter.js';
import { hooks } from './actions.js';
import { toast } from '../ui/dom.js';
import { packSources } from '../io/packs.js';

const INTERP = { smooth: SMOOTH, linear: LINEAR, ease: EASE, step: STEP };
let ctxRefs = {};
let catalog = null;

const need = () => {
  if (!app.model) throw new Error('No model loaded. Use load_model first.');
};
const fps = () => app.fps;
const frames = (sec) => Math.round(sec * fps());

function findClip(name) {
  if (!name) {
    if (!app.clip) throw new Error('No clip selected');
    return app.committedClip;
  }
  const c = app.clips.find((x) => x.name === name) || app.clips.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!c) throw new Error(`Clip "${name}" not found. Use list_clips.`);
  return c;
}

function showLive(clip, play = true) {
  ctxRefs.moveMaker?.active && ctxRefs.moveMaker.close();
  app.selectClip(clip.id, { keepTime: true });
  if (play) app.setPlaying(true);
}

function clipInfo(c) {
  return {
    name: c.name,
    frames: frames(c.duration),
    seconds: +c.duration.toFixed(3),
    loop: !!c.loop,
    source: c.meta?.source,
    note: c.meta?.note,
    layers: c.layers.map((l) => `${l.name} (${l.mode}${l.mute ? ', muted' : ''})`),
    keys: clipKeyCount(c),
    generator: c.meta?.generator || undefined,
  };
}

async function getCatalog() {
  if (catalog) return catalog;
  return (catalog = buildCatalog(await packSources()));
}

function addAndShow(clip, label) {
  const used = new Set(app.clips.map((c) => c.name));
  let n = clip.name,
    k = 2;
  while (used.has(n)) n = `${clip.name}_${k++}`;
  clip.name = n;
  app.addClip(clip, label);
  showLive(app.committedClip);
  return clipInfo(app.committedClip);
}

/** Apply anatomical pose specs as keys. specs: [{frame|seconds, bones: {ref: {swing,spread,twist}}, hips: {move:[l,u,f], ...rot}}] */
function keyPoses(clip, specs, { relative = false, interp = 'smooth', layer = null } = {}) {
  const rig = app.rig;
  const li = layer != null ? Math.max(0, clip.layers.findIndex((l) => l.name === layer || l.id === layer)) : app.layerIndex;
  const ip = INTERP[interp] ?? SMOOTH;
  const report = { keyed: 0, unknown: new Set() };
  const x = makeXform();
  for (const spec of specs) {
    const t = Math.min(clip.duration, Math.max(0, spec.seconds ?? (spec.frame ?? 0) / fps()));
    const bones = { ...(spec.bones || {}) };
    if (spec.hips) bones.hips = spec.hips;
    for (const [ref, v] of Object.entries(bones)) {
      const i = ref === 'hips' ? rig.special.hips : resolveBone(rig, ref);
      if (i == null || i < 0) {
        report.unknown.add(ref);
        continue;
      }
      evalBone(clip, rig.names[i], t, rig.rest[i], x);
      const hasRot = v.swing != null || v.spread != null || v.twist != null;
      const q = hasRot ? anatomicalLocal(rig, i, v, relative ? x.q : null) : x.q.clone();
      const p = v.move ? bodyOffsetLocal(rig, i, v.move, relative ? x.p : null) : x.p.clone();
      keyBone(clip, li, rig.names[i], t, { p, q, s: x.s.clone() }, rig.rest[i], { rot: hasRot, pos: !!v.move, scl: false }, ip);
      report.keyed++;
    }
    // IK targets after the angles: { ik: { 'hand.R': [l,u,f] (from chest), 'foot.L': [l,u,f] (from root) }, poles }
    if (spec.ik && Object.keys(spec.ik).length) {
      applyPose(clip, t, rig);
      app.model.root.updateMatrixWorld(true);
      const r = solveLimbTargets(rig, spec.ik, spec.poles || {});
      for (const i of new Set(r.changed)) {
        const b = rig.bones[i];
        keyBone(clip, li, rig.names[i], t, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }, rig.rest[i], { rot: true, pos: false, scl: false }, ip);
        report.keyed++;
      }
      for (const [k, cm] of Object.entries(r.misses)) if (cm > 1.5) (report.ik_misses ||= []).push({ frame: Math.round(t * fps()), limb: k, miss_cm: cm });
    }
  }
  return { keyed: report.keyed, unknown_bones: [...report.unknown], ik_misses: report.ik_misses };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const H = {
  async status() {
    const lib = await listLibrary();
    return {
      model: app.model?.name || null,
      humanoid: !!app.rig?.humanoid,
      bones: app.rig?.bones.length || 0,
      clips: app.clips.length,
      current_clip: app.clip ? clipInfo(app.clip) : null,
      frame: frames(app.time),
      playing: app.playing,
      fps: fps(),
      selected_bones: [...app.sel.bones].map((i) => app.rig.kind[i] || app.rig.names[i]),
      library_moves: lib.length,
      project: app.project.name,
      unsaved: app.project.dirty,
    };
  },

  async list_models() {
    return (await api.models()).map((m) => ({ name: m.name, folder: m.folder }));
  },

  async load_model({ name }) {
    const m = (await api.models()).find((x) => x.name === name || x.name.toLowerCase() === String(name).toLowerCase() || x.name.replace(/\.glb$/i, '').toLowerCase() === String(name).toLowerCase());
    if (!m) throw new Error(`Model "${name}" not found. Use list_models.`);
    if (app.project.dirty) await autosaveNow();
    ctxRefs.moveMaker?.active && ctxRefs.moveMaker.close();
    const ok = await openModel(m.url, m.name, { skipConfirm: true });
    if (!ok) throw new Error('Could not open the model');
    return H.status();
  },

  async get_rig() {
    need();
    const r = app.rig;
    return {
      humanoid: r.humanoid,
      height_m: +r.height.toFixed(3),
      bones: controllableBones(r),
      conventions:
        'key_pose uses anatomical degrees relative to the rest pose: swing + = bone tip moves FORWARD (for bones pointing forward like feet: UP); knee bend = NEGATIVE calf swing; elbow bend = POSITIVE forearm swing. spread + = tip moves away from the body midline (centre bones: toward the character\'s left). twist + = roll around the bone. hips.move = [left, up, forward] metres. Values are absolute (relative to rest) unless relative=true.',
    };
  },

  async list_clips() {
    need();
    return app.clips.map((c) => ({ name: c.name, frames: frames(c.duration), loop: !!c.loop, source: c.meta?.source || 'original', edited: c.meta?.original ? app.originals.get(c.meta.originalName) !== c : undefined }));
  },

  async select_clip({ name, play = true }) {
    need();
    const c = findClip(name);
    showLive(c, play);
    return clipInfo(c);
  },

  async play({ play = true, clip, speed }) {
    need();
    if (clip) app.selectClip(findClip(clip).id);
    if (speed) app.set('speed', speed);
    app.setPlaying(play);
    return { playing: app.playing, clip: app.clip?.name };
  },

  async set_time({ frame, seconds }) {
    need();
    app.setPlaying(false);
    app.setTime(seconds ?? (frame || 0) / fps(), { snap: true });
    return { frame: frames(app.time) };
  },

  async create_clip({ name = 'NewMove', frames: f = 60, loop = false }) {
    need();
    const c = makeClip(name, Math.max(1, f) / fps());
    c.loop = !!loop;
    c.meta = { source: 'new', note: 'created via AI bridge' };
    const info = addAndShow(c, 'Create clip');
    app.setPlaying(false);
    return info;
  },

  async delete_clip({ name }) {
    need();
    const names = (Array.isArray(name) ? name : [name]).map((n) => findClip(n).id);
    app.editClips('AI: delete clip', (arr) => arr.filter((c) => !names.includes(c.id)));
    return { deleted: names.length, clips: app.clips.map((c) => c.name) };
  },

  async rename_clip({ name, to }) {
    need();
    const c = findClip(name);
    if (!to || app.clips.some((x) => x.name === to && x.id !== c.id)) throw new Error(`"${to}" is empty or already used`);
    app.edit('AI: rename clip', (d) => void (d.name = String(to)), { clipId: c.id });
    return { renamed: to };
  },

  async set_loop({ name, loop = true }) {
    need();
    const c = findClip(name);
    app.edit('AI: set loop', (d) => void (d.loop = !!loop), { clipId: c.id });
    return { name: c.name, loop: !!loop };
  },

  async key_pose({ clip, poses, frame, seconds, bones, hips, ik = null, poles = null, relative = false, interp = 'smooth', layer = null, extend = true }) {
    need();
    const target = findClip(clip);
    const specs = poses || [{ frame, seconds, bones, hips, ik, poles }];
    let res;
    app.edit('AI: key pose', (d) => {
      if (extend) {
        const maxT = Math.max(...specs.map((s) => s.seconds ?? (s.frame ?? 0) / fps()));
        if (maxT > d.duration) d.duration = maxT;
      }
      res = keyPoses(d, specs, { relative, interp, layer });
    }, { clipId: target.id });
    const edited = app.clips.find((x) => x.id === target.id);
    showLive(edited, specs.length > 1);
    if (specs.length === 1) app.setTime(specs[0].seconds ?? (specs[0].frame ?? 0) / fps());
    return { ...res, clip: clipInfo(edited) };
  },

  async delete_keys({ clip, frames: fr = null, bones = null }) {
    need();
    const target = findClip(clip);
    const rig = app.rig;
    const names = bones ? bones.map((b) => rig.names[resolveBone(rig, b)]).filter(Boolean) : null;
    let n = 0;
    app.edit('AI: delete keys', (d) => {
      const L = d.layers[app.layerIndex] || d.layers[0];
      for (const bone in L.tracks) {
        if (names && !names.includes(bone)) continue;
        for (const k of TYPES) {
          const ch = L.tracks[bone][k];
          if (!ch) continue;
          const idx = fr ? fr.map((f) => findKey(ch, f / fps(), 0.45 / fps())).filter((i) => i >= 0) : [...ch.times.keys()];
          n += idx.length;
          removeKeys(ch, idx);
        }
      }
      pruneLayer(L);
    }, { clipId: target.id });
    return { deleted: n };
  },

  async list_motion_types() {
    return Object.fromEntries(MOTION_TYPES.map((k) => [k, GAITS[k]]));
  },

  async generate_motion({ type = 'walk', params = {}, name = null, cycles = 1 }) {
    need();
    if (!app.rig.humanoid) throw new Error('The character has no recognised humanoid skeleton. Run build_skeleton first.');
    const c = generateMotion(app.rig, type, { ...params, cycles, name: name || `${type[0].toUpperCase()}${type.slice(1)}_new` });
    return addAndShow(c, `AI: generate ${type}`);
  },

  async regenerate_motion({ clip, params = {}, type = null }) {
    need();
    const c = findClip(clip);
    const gen = c.meta?.generator;
    if (!gen) throw new Error(`"${c.name}" was not made by generate_motion. Use adjust_motion instead.`);
    const merged = { ...gen.params, ...params };
    const n = generateMotion(app.rig, type || gen.type, { ...merged, name: c.name });
    n.id = c.id;
    app.editClips('AI: regenerate motion', (arr) => arr.map((x) => (x.id === c.id ? n : x)));
    showLive(app.committedClip);
    return clipInfo(n);
  },

  async adjust_motion({ clip, params = {}, as_new = false, name = null }) {
    need();
    const c = findClip(clip);
    const unknown = Object.keys(params).filter((k) => !(k in STYLE_DEFAULTS));
    const styled = applyStyle(c, app.rig, params, { fps: fps() });
    styled.meta = { ...c.meta, source: c.meta?.source === 'original' ? 'derived' : c.meta?.source, note: `${c.meta?.note || ''} · adjusted`.trim(), original: false };
    if (as_new) {
      styled.name = name || `${c.name}_adjusted`;
      return { ...addAndShow(styled, 'AI: adjust motion'), unknown_params: unknown };
    }
    styled.id = c.id;
    styled.name = name || c.name;
    app.editClips('AI: adjust motion', (arr) => arr.map((x) => (x.id === c.id ? styled : x)));
    showLive(app.committedClip);
    return { ...clipInfo(styled), unknown_params: unknown };
  },

  async apply_modifier({ op, params = {}, clip = null, bones = 'all', from_frame = null, to_frame = null }) {
    need();
    const def = OPS.find((o) => o.id === op);
    if (!def) throw new Error(`Unknown modifier "${op}". Available: ${OPS.map((o) => o.id).join(', ')}`);
    const c = findClip(clip);
    const values = { ...Object.fromEntries(def.fields.map((f) => [f.key, f.value])), ...params };
    const range = from_frame != null && to_frame != null ? [from_frame / fps(), to_frame / fps()] : null;
    const ctx = { rig: app.rig, li: app.layerIndex, fps: fps(), bones: def.noBones ? null : resolveBones(bones), range };
    let msg;
    app.edit(`AI: ${def.title}`, (d) => (msg = def.apply(d, ctx, values)), { clipId: c.id });
    const edited = app.clips.find((x) => x.id === c.id);
    showLive(edited);
    return { applied: def.title, message: typeof msg === 'string' ? msg : undefined, clip: clipInfo(edited) };
  },

  async list_moves({ source = 'reference', category = null, query = null }) {
    if (source === 'library') {
      const lib = await listLibrary();
      return lib.filter((m) => (!category || m.category === category) && (!query || m.name.toLowerCase().includes(query.toLowerCase()))).map((m) => ({ name: m.name, file: m.file, category: m.category, seconds: m.duration, loop: m.loop }));
    }
    const cat = await getCatalog();
    return {
      categories: CATEGORIES.map((c) => c.id),
      moves: cat.filter((m) => (!category || m.category === category) && (!query || `${m.title} ${m.key}`.toLowerCase().includes(query.toLowerCase()))).map((m) => ({ key: m.key, title: m.title, category: m.category, styles: m.variants.map((v) => v.label) })),
    };
  },

  async add_move({ move, style_from = null, from_library = false, params = {}, name = null }) {
    need();
    let base, title;
    if (from_library) {
      const lib = await listLibrary();
      const it = lib.find((m) => m.name.toLowerCase() === String(move).toLowerCase() || m.file === move);
      if (!it) throw new Error(`"${move}" is not in your library. Use list_moves with source "library".`);
      base = moveOnCharacter((await loadMove(it.file)).clip, app.rig, it.name);
      title = it.name;
    } else {
      const cat = await getCatalog();
      const m = cat.find((x) => x.key.toLowerCase() === String(move).toLowerCase() || x.title.toLowerCase() === String(move).toLowerCase());
      if (!m) throw new Error(`Move "${move}" not found. Use list_moves.`);
      const v = (style_from && m.variants.find((x) => x.label.toLowerCase().startsWith(style_from.toLowerCase()) || x.model.toLowerCase().startsWith(style_from.toLowerCase()))) || m.variants[0];
      const src = await loadAnimSource(v.url, v.model);
      base = retargetClip(src.byName.get(v.clip), src.rig, app.rig, { mode: 'auto', name: m.key }).clip;
      title = m.key;
    }
    const clip = Object.keys(params).length ? applyStyle(base, app.rig, params, { fps: fps() }) : base;
    clip.name = name || title;
    clip.meta = { source: 'derived', note: `via AI from ${from_library ? 'my library' : 'pack'}: ${move}` };
    clip.layers.push(makeLayer('My edits', 'additive')); // same as ✦ Moves: hand edits go on top
    return addAndShow(clip, 'AI: add move');
  },

  async library_save({ clip = null, name = null, category = 'other' }) {
    need();
    const c = findClip(clip);
    const std = standardRig();
    const onStd = retargetClip(c, app.rig, std, { mode: 'auto', name: name || c.name }).clip;
    onStd.loop = c.loop;
    const file = await saveMove({ key: name || c.name, title: name || c.name, category, clip: onStd, note: `saved from ${app.model.name} › ${c.name}` });
    return { saved: file };
  },

  async library_build_move({ move, styles = null }) {
    const cat = await getCatalog();
    const m = cat.find((x) => x.key.toLowerCase() === String(move).toLowerCase() || x.title.toLowerCase() === String(move).toLowerCase());
    if (!m) throw new Error(`Move "${move}" not found`);
    const variants = styles ? m.variants.filter((v) => styles.some((s) => v.label.toLowerCase().startsWith(s.toLowerCase()) || v.model.toLowerCase().startsWith(s.toLowerCase()))) : m.variants;
    const { clip, used } = await buildStandardMove(m, variants);
    const file = await saveMove({ key: m.key, title: m.title, category: m.category, clip, sources: variants.map((v) => `${v.model} › ${v.clip}`), note: `blend of ${used} style(s)` });
    return { saved: file, styles_used: used };
  },

  async build_skeleton() {
    need();
    const rb = ctxRefs.rigBuilder;
    await rb.open({ skipConfirm: true });
    if (!rb.active) throw new Error('Skeleton builder could not start');
    rb.build();
    return H.status();
  },

  async snapshot({ view = null, frame = null, width = 900 }) {
    need();
    const vp = ctxRefs.viewport;
    if (view) vp.frameModel(view, ctxRefs.moveMaker?.active || vp.builder ? 350 : 0);
    if (frame != null) {
      app.setPlaying(false);
      app.setTime(frame / fps());
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    vp.renderer.render(vp.scene, vp.camera);
    const src = vp.renderer.domElement;
    const s = Math.min(1, width / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * s);
    c.height = Math.round(src.height * s);
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(c.width / 2, c.height * 0.35, 10, c.width / 2, c.height * 0.35, Math.max(c.width, c.height) * 0.75);
    bg.addColorStop(0, '#232836');
    bg.addColorStop(1, '#15181f');
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return { image: c.toDataURL('image/jpeg', 0.85), clip: app.clip?.name, frame: frames(app.time) };
  },

  async set_view({ view = 'persp' }) {
    need();
    ctxRefs.viewport.frameModel(view, 0);
    return { view };
  },

  async export_glb({ name = null, which = 'mine', content = 'model' }) {
    need();
    const base = app.model.name.replace(/\.(glb|gltf)$/i, '');
    const mine = (c) => !c.meta.original || app.originals.get(c.meta.originalName) !== c;
    const clips = which === 'all' ? app.clips : which === 'current' ? [app.committedClip] : which === 'checked' ? app.clips.filter((c) => app.isExported(c.id)) : app.clips.filter(mine);
    if (!clips.length) throw new Error('No clips to export');
    const glb = await exportGLB(app.model, clips, { fps: 30, includeMesh: content !== 'anim', fillRest: true });
    hooks.refreshPose();
    const file = (name || `${base}_anim`).replace(/\.glb$/i, '') + '.glb';
    const r = await api.exportFile(file, new Blob([glb], { type: 'model/gltf-binary' }));
    toast(`AI exported ${clips.length} clip(s) → ${file}`, 'ok');
    return { path: r.path, clips: clips.map((c) => c.name), bytes: r.size };
  },

  async open_project({ name }) {
    const file = /\.animproj\.json$/i.test(name) ? name : `${name}.animproj.json`;
    if (app.project.dirty && app.model) await autosaveNow();
    app.project.dirty = false;
    await openProjectByName(file);
    return H.status();
  },

  async save_project({ name = null }) {
    need();
    if (name) app.project.name = name;
    if (!app.project.name) app.project.name = app.model.name.replace(/\.(glb|gltf)$/i, '') + ' project';
    await saveProject();
    return { project: app.project.name };
  },

  async add_sockets() {
    need();
    const added = await addWeaponSockets();
    return { added, sockets: SOCKETS.filter((s) => app.rig.byName.has(s.name)).map((s) => s.name), model: app.model.name };
  },

  async save_rigged_model() {
    need();
    return saveRiggedModel();
  },

  async list_props() {
    need();
    const files = await api.props();
    return {
      sockets: SOCKETS.map((s) => ({ name: s.name, where: s.label, present: app.rig.byName.has(s.name) })),
      builtin: Object.keys(BUILTIN_PROPS),
      files: files.map((f) => f.name),
      attached: (app.project.props || []).map((p) => ({ name: p.name, source: p.source, socket: p.socket, pos: p.pos, rot: p.rot, scale: p.scale, visible: p.visible !== false })),
      conventions: 'Prop origin = main-hand grip, +Z = muzzle, +Y = up. pos (metres) / rot (degrees, XYZ) are offsets in the socket frame, which at rest equals the character frame (X left, Y up, Z forward).',
    };
  },

  async attach_prop({ prop, socket = null, name = null, pos = null, rot = null, scale = 1, replace = true }) {
    need();
    return attachProp({ prop, socket, name, pos, rot, scale, replace });
  },

  async update_prop({ name, ...changes }) {
    need();
    return updateProp(name, changes);
  },

  async key_weapon_pose({ clip = null, poses, prop = null, support = true, elbow = 'down', support_elbow = 'down', layer = null }) {
    need();
    const c = findClip(clip);
    const r = await keyWeaponPoses(c, poses, { propView: ctxRefs.propView, prop, support, elbow, supportElbow: support_elbow, layer });
    showLive(app.clips.find((x) => x.id === c.id), poses.length > 1);
    if (poses.length === 1) app.setTime((poses[0].frame ?? 0) / fps());
    return r;
  },

  async key_support_hand({ clip = null, frames = null, prop = null, side = 'L', elbow = 'down', layer = null }) {
    need();
    const c = findClip(clip);
    const all = [...new Set(c.layers.flatMap((l) => Object.values(l.tracks).flatMap((tr) => Object.values(tr).flatMap((ch) => [...ch.times]))))].map((t) => Math.round(t * fps()));
    return keySupportHand(c, (frames || all).sort((a, b) => a - b), { propView: ctxRefs.propView, prop, side, elbow, layer });
  },

  async remove_prop({ name = 'all' }) {
    need();
    return removeProp(name);
  },

  async undo() {
    return { undone: app.undo() };
  },
  async redo() {
    return { redone: app.redo() };
  },

  async list_commands() {
    return cmds
      .all()
      .filter((c) => !c.hidden)
      .map((c) => ({ id: c.id, label: c.label, category: c.category }));
  },

  async run_command({ id, args = [] }) {
    const c = cmds.get(id);
    if (!c) throw new Error(`Unknown command "${id}". Use list_commands.`);
    // Don't block on interactive dialogs: start the command and report.
    const r = cmds.run(id, ...(Array.isArray(args) ? args : [args]));
    if (r && typeof r.then === 'function') r.catch((e) => console.warn(e));
    return { started: id, note: r && typeof r.then === 'function' ? 'Command may have opened a dialog for the user.' : undefined };
  },

  async select_bones({ bones = [] }) {
    need();
    const idx = bones.map((b) => resolveBone(app.rig, b)).filter((i) => i >= 0);
    app.selectBones(idx);
    return { selected: idx.map((i) => app.rig.kind[i] || app.rig.names[i]) };
  },
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
export function startBridge(refs) {
  ctxRefs = refs;
  let es;
  const connect = () => {
    es = new EventSource('/api/bridge/events');
    es.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const fn = H[msg.cmd];
      let out;
      try {
        if (!fn) throw new Error(`Unknown command "${msg.cmd}"`);
        app.setStatus(`🤖 AI: ${msg.cmd.replace(/_/g, ' ')}`);
        const result = await fn(msg.args || {});
        out = { id: msg.id, ok: true, result };
      } catch (e) {
        console.warn('[bridge]', msg.cmd, e);
        out = { id: msg.id, ok: false, error: e.message || String(e) };
      }
      fetch('/api/bridge/result', { method: 'POST', body: JSON.stringify(out) }).catch(() => {});
    };
    es.onerror = () => {
      es.close();
      setTimeout(connect, 2000);
    };
  };
  connect();
}

export const BRIDGE_COMMANDS = Object.keys(H);
export { bodyAxes };
