// AnimStudio entry point: builds the UI, registers commands, wires shortcuts.
import { app } from './app/state.js';
import { register, run, all, get, enabled, eventCombo, findByCombo, shortcutText } from './app/commands.js';
import * as A from './app/actions.js';
import * as D from './app/dialogs.js';
import { OPS, runOp } from './app/oprunner.js';
import { openModel, saveProject, startAutosave, openProjectJson, confirmDiscard, saveRiggedModel, addWeaponSockets } from './app/session.js';
import { PropView, propsDialog } from './ui/props.js';
import { api } from './io/api.js';
import * as ops from './core/ops.js';
import { cloneClip, makeClip, getTrack, pruneLayer, makeLayer } from './core/clip.js';
import { setKey, SMOOTH, LINEAR, EASE, STEP } from './core/channel.js';
import { bonesInSet, GROUPS, boneTitle } from './core/rig.js';
import { h, clear, toast, popupMenu, closeMenus, isMenuOpen, rafThrottle } from './ui/dom.js';
import { formDialog, promptDialog, confirmDialog, openModal, dialogOpen } from './ui/dialog.js';
import { Viewport } from './ui/viewport.js';
import { Bottom } from './ui/bottom.js';
import { tv } from './ui/timeview.js';
import { ClipsPanel } from './ui/panels/clips.js';
import { PosesPanel } from './ui/panels/poses.js';
import { PosePanel } from './ui/panels/inspector.js';
import { LayersPanel } from './ui/panels/layers.js';
import { ModifyPanel } from './ui/panels/modify.js';
import { ClipPanel } from './ui/panels/clipinfo.js';
import { RigPanel } from './ui/panels/rig.js';
import { RigBuilder } from './ui/rigbuilder.js';
import { MoveMaker } from './ui/movemaker.js';
import { startBridge } from './app/bridge.js';

const VERSION = '2.0.0';
const $ = (id) => document.getElementById(id);

// =============================================================================
// Layout
// =============================================================================
document.documentElement.style.setProperty('--bottom-h', `${app.settings.bottomH}px`);
const viewport = new Viewport($('viewport'));
const bottom = new Bottom($('bottom'));
const rigBuilder = new RigBuilder(viewport);
const moveMaker = new MoveMaker(viewport);
const propView = new PropView(viewport);
new ClipsPanel($('left'));
new PosesPanel($('left'));

const RIGHT_TABS = [
  ['pose', 'Pose', PosePanel],
  ['layers', 'Layers', LayersPanel],
  ['modify', 'Modify', ModifyPanel],
  ['clip', 'Clip', ClipPanel],
  ['rig', 'Rig', RigPanel],
];
const rightTabs = h('div', { class: 'tabs' });
const rightBodies = {};
const rightPanels = {};
$('right').append(rightTabs);
for (const [id, label, Cls] of RIGHT_TABS) {
  const body = h('div', { class: 'col hidden', style: { flex: 1, minHeight: 0, gap: 0 } });
  $('right').append(body);
  rightBodies[id] = body;
  rightPanels[id] = new Cls(body);
  rightTabs.append(h('button', { dataset: { tab: id }, onclick: () => showTab(id) }, label));
}
function showTab(id) {
  app.set('rightTab', id);
  for (const [k, body] of Object.entries(rightBodies)) body.classList.toggle('hidden', k !== id);
  rightTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  rightPanels[id].show?.();
}
showTab(app.settings.rightTab || 'pose');

// Splitter between the workspace and the bottom panel.
{
  const sp = $('hsplit');
  let start = null;
  sp.addEventListener('pointerdown', (e) => {
    start = { y: e.clientY, h: app.settings.bottomH };
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('drag');
  });
  sp.addEventListener('pointermove', (e) => {
    if (!start) return;
    const hh = Math.min(window.innerHeight - 220, Math.max(120, start.h - (e.clientY - start.y)));
    document.documentElement.style.setProperty('--bottom-h', `${hh}px`);
    app.settings.bottomH = hh;
  });
  sp.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    sp.classList.remove('drag');
    app.set('bottomH', app.settings.bottomH);
  });
}

// =============================================================================
// Commands
// =============================================================================
const hasModel = () => !!app.model;
const hasClip = () => !!app.clip;
const hasBones = () => app.sel.bones.size > 0;
let lastCopied = 'pose';

const rig = () => app.rig;
const selIdx = () => [...app.sel.bones];

async function newClip() {
  if (!app.model) return;
  const v = await formDialog({
    title: 'New animation',
    intro: 'Starts from the pose you see now. Move the playhead, pose the body and keys are recorded (auto-key). Tip: copy a pose from another clip first.',
    ok: 'Create',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: 'MyAnimation' },
      { key: 'frames', label: 'Length (frames)', type: 'number', min: 1, step: 1, value: 60 },
      { key: 'loop', type: 'checkbox', text: 'Looping animation (end key copies the start pose)', value: false, full: true },
    ],
  });
  if (!v) return;
  const r = rig();
  const clip = makeClip(v.name || 'MyAnimation', Math.max(1, v.frames) / app.fps);
  clip.loop = !!v.loop;
  const base = clip.layers[0];
  for (let i = 0; i < r.bones.length; i++) {
    if (r.group[i] === 'attach') continue;
    const b = r.bones[i];
    const restQ = r.rest[i].q;
    const moved = 1 - Math.abs(b.quaternion.dot(restQ)) > 1e-7 || b.position.distanceTo(r.rest[i].p) > 1e-6 || r.core.has(i);
    if (!moved) continue;
    const times = clip.loop ? [0, clip.duration] : [0];
    for (const t of times) {
      setKey(getTrack(base, r.names[i], 'rot', true), t, b.quaternion.toArray(), SMOOTH);
      if (b.position.distanceTo(r.rest[i].p) > 1e-6 || r.kind[i] === 'hips') setKey(getTrack(base, r.names[i], 'pos', true), t, b.position.toArray(), SMOOTH);
    }
  }
  clip.meta = { source: 'new', note: 'created in AnimStudio' };
  app.addClip(clip, 'New clip');
  app.setTime(0);
  toast(`“${clip.name}” created — pose the body at other frames to animate`, 'ok');
}

async function renameClip(name) {
  const c = app.clip;
  if (!c) return;
  const n = typeof name === 'string' ? name : await promptDialog('Rename clip', c.name, { label: 'Name' });
  if (!n || n === c.name) return;
  if (app.clips.some((x) => x.name === n && x.id !== c.id)) return toast('A clip with that name exists', 'err');
  app.edit('Rename clip', (d) => (d.name = n));
}

async function deleteClip() {
  const c = app.clip;
  if (!c) return;
  if (!(await confirmDialog('Delete clip', `Delete “${c.name}”? (You can undo.)`, { ok: 'Delete', danger: true }))) return;
  const idx = app.clips.indexOf(app.committedClip);
  app.editClips('Delete clip', (arr) => arr.filter((x) => x.id !== c.id));
  const next = app.clips[Math.min(idx, app.clips.length - 1)];
  if (next) app.selectClip(next.id);
}

function derived(label, fn, suffix) {
  const c = app.clip;
  if (!c) return;
  const copy = cloneClip(c, true);
  fn(copy);
  copy.name = `${c.name}${suffix}`;
  copy.meta = { source: 'derived', note: `${label} of ${c.name}` };
  app.addClip(copy, label);
}

function setCompare(id) {
  app.compareClipId = app.compareClipId === id ? null : id;
  viewport.ghostsDirty = true;
  app.emit('view');
  toast(app.compareClipId ? `Ghost: ${app.clipById(id)?.name}` : 'Ghost off');
}

register(
  // ---------------------------------------------------------------- file
  { id: 'file.open', label: 'Open model…', category: 'File', keys: ['Ctrl+O'], run: () => D.welcome() },
  { id: 'file.openFile', label: 'Open character file (.glb / .fbx)…', category: 'File', run: async () => { const f = await D.pickFile('.glb,.gltf,.fbx'); if (f) openModel(await f.arrayBuffer(), f.name); } },
  { id: 'file.openProject', label: 'Open project file…', category: 'File', run: async () => { const f = await D.pickFile('.json'); if (f) openProjectJson(JSON.parse(await f.text()), f.name.replace(/\.animproj\.json$/i, '')); } },
  { id: 'file.save', label: 'Save project', category: 'File', keys: ['Ctrl+S'], enabled: hasModel, run: () => saveProject() },
  { id: 'file.saveAs', label: 'Save project as…', category: 'File', keys: ['Ctrl+Shift+S'], enabled: hasModel, run: () => saveProject({ as: true }) },
  { id: 'file.import', label: 'Import clips / file…', category: 'File', keys: ['Ctrl+I'], run: () => D.importFile() },
  { id: 'file.export', label: 'Export GLB…', category: 'File', keys: ['Ctrl+E'], enabled: hasModel, run: () => D.exportDialog() },
  { id: 'file.exportCurrent', label: 'Export current clip…', category: 'File', enabled: hasClip, run: () => D.exportDialog({ only: app.clip }) },
  { id: 'file.exportClipJson', label: 'Save clip as JSON', category: 'File', enabled: hasClip, run: () => D.exportClipJson() },
  { id: 'file.showExports', label: 'Show exports folder', category: 'File', run: async () => { try { const i = await api.info(); await api.reveal(i.exportDir); } catch { toast('Server not available', 'err'); } } },
  { id: 'app.settings', label: 'Preferences…', category: 'File', keys: ['Ctrl+,'], run: () => D.settingsDialog() },
  // ---------------------------------------------------------------- edit
  { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['Ctrl+Z'], enabled: () => app.history.canUndo, run: () => { const l = app.undo(); if (l) app.setStatus(`Undo: ${l}`); } },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], enabled: () => app.history.canRedo, run: () => { const l = app.redo(); if (l) app.setStatus(`Redo: ${l}`); } },
  { id: 'edit.copy', label: 'Copy (keys or pose)', category: 'Edit', keys: ['Ctrl+C'], enabled: hasModel, run: () => { if (app.keySel.size) { A.copyKeys(); lastCopied = 'keys'; } else { A.copyPose(selIdx()); lastCopied = 'pose'; } } },
  { id: 'edit.paste', label: 'Paste (keys or pose) at playhead', category: 'Edit', keys: ['Ctrl+V'], enabled: hasClip, run: () => (lastCopied === 'keys' ? A.pasteKeys() : A.pastePose()) },
  { id: 'edit.pasteMirror', label: 'Paste mirrored', category: 'Edit', keys: ['Ctrl+Shift+V'], enabled: hasClip, run: () => (lastCopied === 'keys' ? A.pasteKeys({ mirror: true }) : A.pastePose({ mirror: true })) },
  { id: 'edit.delete', label: 'Delete keys', category: 'Edit', keys: ['Delete', 'Backspace'], enabled: hasClip, run: () => (app.keySel.size ? A.deleteSelectedKeys() : A.deleteKeysAtTime()) },
  { id: 'edit.escape', label: 'Deselect', category: 'Edit', keys: ['Escape'], run: () => { if (app.keySel.size) { app.keySel = new Set(); app.emit('keySel'); } else app.clearBones(); } },
  // ---------------------------------------------------------------- keys
  { id: 'key.selected', label: 'Key selected bones', category: 'Keys', keys: ['K'], enabled: hasClip, run: () => A.keyBones() },
  { id: 'key.all', label: 'Key whole body', category: 'Keys', keys: ['Shift+K'], enabled: hasClip, run: () => A.keyAll() },
  { id: 'key.deleteAtTime', label: 'Delete key at playhead (selected bones)', category: 'Keys', keys: ['Alt+K'], enabled: hasClip, run: () => A.deleteKeysAtTime() },
  { id: 'keys.copy', label: 'Copy selected keys', category: 'Keys', enabled: () => app.keySel.size > 0, run: () => { A.copyKeys(); lastCopied = 'keys'; } },
  { id: 'keys.paste', label: 'Paste keys at playhead', category: 'Keys', enabled: hasClip, run: () => A.pasteKeys() },
  { id: 'keys.pasteMirror', label: 'Paste keys mirrored', category: 'Keys', enabled: hasClip, run: () => A.pasteKeys({ mirror: true }) },
  { id: 'keys.delete', label: 'Delete selected keys', category: 'Keys', enabled: () => app.keySel.size > 0, run: () => A.deleteSelectedKeys() },
  { id: 'keys.selectAll', label: 'Select all keys', category: 'Keys', keys: ['Ctrl+A'], enabled: hasClip, run: () => A.selectKeys({ range: null }) },
  { id: 'keys.selectRange', label: 'Select keys in range', category: 'Keys', enabled: () => !!app.range, run: () => A.selectKeys({ range: app.range }) },
  { id: 'keys.selectBone', label: 'Select keys of bone', category: 'Keys', hidden: true, run: (bone) => A.selectKeys({ bones: new Set([bone]), range: null }) },
  { id: 'keys.selectSelectedBones', label: 'Select keys of selected bones', category: 'Keys', enabled: hasBones, run: () => A.selectKeys({ bones: new Set(selIdx().map((i) => rig().names[i])), range: null }) },
  { id: 'keys.interp.smooth', label: 'Interpolation: Smooth', category: 'Keys', keys: ['Shift+1'], enabled: hasClip, run: () => A.setSelectedInterp(SMOOTH) },
  { id: 'keys.interp.linear', label: 'Interpolation: Linear', category: 'Keys', keys: ['Shift+2'], enabled: hasClip, run: () => A.setSelectedInterp(LINEAR) },
  { id: 'keys.interp.ease', label: 'Interpolation: Ease in/out', category: 'Keys', keys: ['Shift+3'], enabled: hasClip, run: () => A.setSelectedInterp(EASE) },
  { id: 'keys.interp.step', label: 'Interpolation: Step (hold)', category: 'Keys', keys: ['Shift+4'], enabled: hasClip, run: () => A.setSelectedInterp(STEP) },
  {
    id: 'range.fromKeys',
    label: 'Set range from selected keys',
    category: 'Keys',
    enabled: () => app.keySel.size > 0,
    run: () => {
      const ts = [...app.keySel].map((id) => A.parseKeyId(id).t);
      app.setRange([Math.min(...ts), Math.max(...ts)]);
    },
  },
  { id: 'range.clear', label: 'Clear range', category: 'Keys', enabled: () => !!app.range, run: () => app.setRange(null) },
  // ---------------------------------------------------------------- pose
  { id: 'pose.reset', label: 'Reset selected to rest pose', category: 'Pose', keys: ['Alt+R'], enabled: hasBones, run: () => A.resetToRest() },
  { id: 'pose.copy', label: 'Copy pose', category: 'Pose', enabled: hasModel, run: () => { A.copyPose(selIdx()); lastCopied = 'pose'; } },
  { id: 'pose.paste', label: 'Paste pose', category: 'Pose', enabled: hasClip, run: () => A.pastePose() },
  { id: 'pose.pasteMirror', label: 'Paste pose mirrored', category: 'Pose', enabled: hasClip, run: () => A.pastePose({ mirror: true }) },
  { id: 'pose.mirrorToOther', label: 'Mirror selected → other side', category: 'Pose', keys: ['M'], enabled: hasBones, run: () => A.mirrorToOtherSide() },
  { id: 'pose.flip', label: 'Flip whole pose (L↔R)', category: 'Pose', keys: ['Shift+M'], enabled: hasClip, run: () => A.flipPose() },
  {
    id: 'pose.save',
    label: 'Save pose to library…',
    category: 'Pose',
    enabled: hasModel,
    run: async () => {
      const r = rig();
      const sel = selIdx();
      const v = await formDialog({
        title: 'Save pose',
        ok: 'Save',
        fields: [
          { key: 'name', label: 'Name', type: 'text', value: `${app.clip?.name || 'Pose'} f${Math.round(app.time * app.fps)}` },
          { key: 'which', label: 'Bones', type: 'seg', value: sel.length ? 'sel' : 'all', options: [{ value: 'all', label: 'Whole body' }, { value: 'sel', label: `Selected (${sel.length})` }] },
        ],
      });
      if (!v) return;
      const idx = v.which === 'sel' && sel.length ? sel : r.bones.map((_, i) => i).filter((i) => r.group[i] !== 'attach');
      const pose = { id: 'P' + Math.random().toString(36).slice(2, 9), name: v.name || 'Pose', bones: A.capturePose(idx), thumb: viewport.capture(112), created: Date.now() };
      app.updatePoses('Save pose', (arr) => [...arr, pose]);
      toast(`Saved pose “${pose.name}”`, 'ok');
    },
  },
  {
    id: 'bone.nickname',
    label: 'Name bone…',
    category: 'Pose',
    enabled: () => app.sel.active >= 0,
    run: async () => {
      const i = app.sel.active;
      const r = rig();
      const n = await promptDialog(`Name ${r.names[i]}`, app.nick[r.names[i]] || r.labels[i] || '', { label: 'Your name for this bone (empty = automatic label)' });
      if (n === null) return;
      app.setNick(r.names[i], n && n !== r.labels[i] ? n : '');
    },
  },
  { id: 'select.parent', label: 'Select parent bone', category: 'Pose', keys: ['['], enabled: () => app.sel.active >= 0, run: () => { const p = rig().parent[app.sel.active]; if (p >= 0) app.selectBones([p]); } },
  { id: 'select.child', label: 'Select child bone', category: 'Pose', keys: [']'], enabled: () => app.sel.active >= 0, run: () => { const c = rig().children[app.sel.active][0]; if (c !== undefined) app.selectBones([c]); } },
  { id: 'select.mirror', label: 'Select mirror bone', category: 'Pose', keys: ['Ctrl+M'], enabled: () => app.sel.active >= 0, run: () => { const m = rig().mirror[app.sel.active]; if (m >= 0) app.selectBones([m]); } },
  ...GROUPS.filter((g) => g.id !== 'attach').map((g) => ({ id: `select.${g.id}`, label: `Select ${g.label}`, category: 'Pose', enabled: hasModel, run: () => app.selectBones(bonesInSet(rig(), g.id)) })),
  // ---------------------------------------------------------------- clip
  { id: 'clip.new', label: 'New clip from current pose…', category: 'Clip', keys: ['Shift+N'], enabled: hasModel, run: newClip },
  { id: 'clip.duplicate', label: 'Duplicate clip', category: 'Clip', keys: ['Ctrl+D'], enabled: hasClip, run: () => derived('Duplicate', () => {}, '_copy') },
  { id: 'clip.rename', label: 'Rename clip…', category: 'Clip', keys: ['F2'], enabled: hasClip, run: renameClip },
  { id: 'clip.delete', label: 'Delete clip', category: 'Clip', enabled: hasClip, run: deleteClip },
  {
    id: 'clip.revert',
    label: 'Revert to original',
    category: 'Clip',
    enabled: () => app.clip?.meta.original && app.originals.get(app.clip.meta.originalName) !== app.committedClip,
    run: () => {
      const c = app.committedClip;
      const orig = app.originals.get(c.meta.originalName);
      app.editClips('Revert clip', (arr) => arr.map((x) => (x.id === c.id ? orig : x)));
      app.selectClip(orig.id, { keepTime: true });
    },
  },
  { id: 'clip.toggleLoop', label: 'Toggle looping', category: 'Clip', enabled: hasClip, run: () => app.edit(app.clip.loop ? 'Mark one-shot' : 'Mark looping', (d) => void (d.loop = !d.loop)) },
  { id: 'clip.setLength', label: 'Set length', category: 'Clip', hidden: true, run: (sec) => sec > 0 && app.edit('Set length', (d) => ops.setDuration(d, sec, false)) },
  { id: 'clip.reverse', label: 'Reverse clip', category: 'Clip', enabled: hasClip, run: () => app.edit('Reverse', (d) => ops.reverse(d)) },
  { id: 'clip.mirrorCopy', label: 'Mirrored copy (L↔R)', category: 'Clip', enabled: hasClip, run: () => derived('Mirror', (c) => ops.mirrorClip(c, { rig: rig() }), '_mirror') },
  { id: 'clip.reverseCopy', label: 'Reversed copy', category: 'Clip', enabled: hasClip, run: () => derived('Reverse', (c) => ops.reverse(c), '_reverse') },
  {
    id: 'clip.addEvent',
    label: 'Add event at playhead…',
    category: 'Clip',
    enabled: hasClip,
    run: async () => {
      const n = await promptDialog(`Event at frame ${Math.round(app.time * app.fps)}`, 'footstep', { label: 'Event name (e.g. footstep, hit, sound_swing)' });
      if (n) app.edit('Add event', (d) => d.events.push({ t: app.time, name: n }));
    },
  },
  { id: 'tools.speed', label: 'Speed / length…', category: 'Clip', enabled: hasClip, run: D.speedDialog },
  { id: 'tools.trim', label: 'Trim to range', category: 'Clip', enabled: () => hasClip() && !!app.range, run: () => { const [a, b] = app.range; app.edit('Trim', (d) => ops.trim(d, a, b)); app.setRange(null); app.setTime(0); } },
  { id: 'tools.cutRange', label: 'Cut range', category: 'Clip', enabled: () => hasClip() && !!app.range, run: () => { const [a, b] = app.range; app.edit('Cut range', (d) => ops.deleteRange(d, a, b, app.fps)); app.setRange(null); } },
  { id: 'tools.hold', label: 'Insert hold at playhead…', category: 'Clip', enabled: hasClip, run: D.holdDialog },
  { id: 'tools.layerClip', label: 'Layer another clip…', category: 'Tools', enabled: hasClip, run: D.layerClipDialog },
  { id: 'tools.concat', label: 'Chain clips…', category: 'Tools', enabled: hasClip, run: D.concatDialog },
  { id: 'tools.blend', label: 'Blend two clips…', category: 'Tools', enabled: hasClip, run: D.blendDialog },
  { id: 'tools.keyPoses', label: 'Key poses / pose-to-pose…', category: 'Tools', enabled: hasClip, run: D.keyPosesDialog },
  { id: 'tools.retarget', label: 'Retarget from another character…', category: 'Tools', enabled: hasModel, run: () => D.retargetDialog() },
  { id: 'tools.moveMaker', label: 'Move Maker (add & adjust moves)…', category: 'Tools', keys: ['Ctrl+Shift+M'], enabled: hasModel, run: () => moveMaker.open() },
  { id: 'tools.moveMakerClip', label: 'Adjust current clip in Move Maker…', category: 'Tools', enabled: hasClip, run: () => moveMaker.open({ fromClip: true }) },
  { id: 'tools.buildSkeleton', label: 'Build / edit skeleton (move joints)…', category: 'Tools', enabled: () => hasModel() && !rigBuilder.active, run: () => rigBuilder.open() },
  { id: 'tools.props', label: 'Weapons & props…', category: 'Tools', keys: ['Ctrl+Shift+W'], enabled: hasModel, run: propsDialog },
  { id: 'tools.addSockets', label: 'Add weapon sockets', category: 'Tools', enabled: () => hasModel() && app.rig.humanoid && !['Weapon_R', 'Weapon_L', 'Weapon_Back'].every((n) => app.rig.byName.has(n)), run: () => addWeaponSockets() },
  { id: 'file.saveRigged', label: 'Save rigged model', category: 'File', enabled: hasModel, run: () => saveRiggedModel() },
  ...OPS.map((o) => ({ id: `op.${o.id}`, label: `${o.title}…`, category: 'Tools', enabled: hasClip, run: () => runOp(o) })),
  // ---------------------------------------------------------------- layers
  {
    id: 'layer.addAdditive',
    label: 'Add additive layer',
    category: 'Layers',
    enabled: hasClip,
    run: () => {
      let id;
      app.edit('Add layer', (d) => {
        const L = makeLayer(`Tweak ${d.layers.length}`, 'additive');
        d.layers.push(L);
        id = L.id;
      });
      app.setLayer(id);
      showTab('layers');
      toast('Additive layer added — pose bones to add offsets on top of the animation');
    },
  },
  {
    id: 'layer.addOverride',
    label: 'Add override layer',
    category: 'Layers',
    enabled: hasClip,
    run: () => {
      let id;
      app.edit('Add layer', (d) => {
        const L = makeLayer(`Override ${d.layers.length}`, 'override');
        d.layers.push(L);
        id = L.id;
      });
      app.setLayer(id);
      showTab('layers');
    },
  },
  {
    id: 'layer.rename',
    label: 'Rename layer…',
    category: 'Layers',
    enabled: hasClip,
    run: async () => {
      const li = app.layerIndex;
      const n = await promptDialog('Rename layer', app.layer.name);
      if (n) app.edit('Rename layer', (d) => (d.layers[li].name = n));
    },
  },
  {
    id: 'layer.duplicate',
    label: 'Duplicate layer',
    category: 'Layers',
    enabled: () => hasClip() && app.layerIndex > 0,
    run: () => {
      const li = app.layerIndex;
      let id;
      app.edit('Duplicate layer', (d) => {
        const L = { ...structuredCloneLayer(d.layers[li]), name: d.layers[li].name + ' copy' };
        d.layers.splice(li + 1, 0, L);
        id = L.id;
      });
      app.setLayer(id);
    },
  },
  {
    id: 'layer.delete',
    label: 'Delete layer',
    category: 'Layers',
    enabled: () => hasClip() && app.layerIndex > 0,
    run: () => {
      const li = app.layerIndex;
      app.edit('Delete layer', (d) => d.layers.splice(li, 1));
      app.setLayer(app.clip.layers[Math.max(0, li - 1)].id);
    },
  },
  { id: 'layer.up', label: 'Move layer up', category: 'Layers', enabled: () => hasClip() && app.layerIndex > 0 && app.layerIndex < app.clip.layers.length - 1, run: () => { const li = app.layerIndex; app.edit('Move layer', (d) => d.layers.splice(li + 1, 0, d.layers.splice(li, 1)[0])); } },
  { id: 'layer.down', label: 'Move layer down', category: 'Layers', enabled: () => hasClip() && app.layerIndex > 1, run: () => { const li = app.layerIndex; app.edit('Move layer', (d) => d.layers.splice(li - 1, 0, d.layers.splice(li, 1)[0])); } },
  {
    id: 'layer.mask',
    label: 'Edit layer mask…',
    category: 'Layers',
    enabled: () => hasClip() && app.layerIndex > 0,
    run: async () => {
      const li = app.layerIndex;
      const L = app.layer;
      const r = rig();
      const current = new Set(L.mask || []);
      const groups = GROUPS.filter((g) => g.id !== 'attach');
      const pre = L.mask ? groups.filter((g) => bonesInSet(r, g.id).some((i) => current.has(r.names[i]))).map((g) => g.id) : groups.map((g) => g.id);
      const v = await formDialog({
        title: `Mask for “${L.name}”`,
        intro: 'The layer only affects the checked body parts.',
        fields: [{ key: 'g', label: 'Body parts', type: 'checklist', bulk: true, value: pre, options: groups.map((g) => ({ value: g.id, label: g.label, swatch: g.color })) }],
      });
      if (!v) return;
      const all = v.g.length === groups.length;
      const mask = all ? null : [...new Set(v.g.flatMap((id) => bonesInSet(r, id).map((i) => r.names[i])))];
      app.edit('Layer mask', (d) => (d.layers[li].mask = mask));
    },
  },
  { id: 'layer.bake', label: 'Merge all layers into Base', category: 'Layers', enabled: () => hasClip() && app.clip.layers.length > 1, run: () => { const m = app.edit('Bake layers', (d) => ops.bakeLayers(d, { rig: rig() }, { fps: app.fps })); app.setLayer(app.clip.layers[0].id); toast(typeof m === 'string' ? m : 'Layers merged', 'ok'); } },
  // ---------------------------------------------------------------- playback
  { id: 'play.toggle', label: 'Play / pause', category: 'Playback', keys: ['Space'], enabled: hasClip, run: () => app.setPlaying(!app.playing) },
  { id: 'time.prevFrame', label: 'Previous frame', category: 'Playback', keys: ['Left'], enabled: hasClip, run: () => (app.setPlaying(false), app.setTime(app.snap(app.time) - 1 / app.fps, { snap: true })) },
  { id: 'time.nextFrame', label: 'Next frame', category: 'Playback', keys: ['Right'], enabled: hasClip, run: () => (app.setPlaying(false), app.setTime(app.snap(app.time) + 1 / app.fps, { snap: true })) },
  { id: 'time.prevKey', label: 'Previous key', category: 'Playback', keys: [','], enabled: hasClip, run: () => A.jumpKey(-1) },
  { id: 'time.nextKey', label: 'Next key', category: 'Playback', keys: ['.'], enabled: hasClip, run: () => A.jumpKey(1) },
  { id: 'time.start', label: 'First frame', category: 'Playback', keys: ['Shift+Left'], enabled: hasClip, run: () => (app.setPlaying(false), app.setTime(app.range ? app.range[0] : 0)) },
  { id: 'time.end', label: 'Last frame', category: 'Playback', keys: ['Shift+Right'], enabled: hasClip, run: () => (app.setPlaying(false), app.setTime(app.range ? app.range[1] : app.duration)) },
  { id: 'play.loop', label: 'Loop playback', category: 'Playback', checked: () => app.settings.loopPlayback, run: () => app.set('loopPlayback', !app.settings.loopPlayback) },
  { id: 'view.autoKey', label: 'Auto-key', category: 'Playback', checked: () => app.settings.autoKey, run: () => app.set('autoKey', !app.settings.autoKey) },
  { id: 'timeline.fit', label: 'Fit timeline', category: 'Playback', keys: ['Home'], run: () => (app.settings.bottomTab === 'graph' ? bottom.graph.fit() : tv.fit(bottom.editorHost.clientWidth)) },
  // ---------------------------------------------------------------- view / tools
  { id: 'tool.select', label: 'Select tool', category: 'View', keys: ['Q'], checked: () => app.settings.tool === 'select', run: () => app.set('tool', 'select') },
  { id: 'tool.rotate', label: 'Rotate tool', category: 'View', keys: ['E'], checked: () => app.settings.tool === 'rotate', run: () => app.set('tool', 'rotate') },
  { id: 'tool.move', label: 'Move tool', category: 'View', keys: ['W'], checked: () => app.settings.tool === 'move', run: () => app.set('tool', 'move') },
  { id: 'tool.ik', label: 'IK tool (hands & feet)', category: 'View', keys: ['I'], checked: () => app.settings.tool === 'ik', run: () => app.set('tool', 'ik') },
  { id: 'tool.space', label: 'Toggle local/world gizmo', category: 'View', keys: ['X'], run: () => app.set('gizmoSpace', app.settings.gizmoSpace === 'local' ? 'world' : 'local') },
  { id: 'view.lockFeet', label: 'Lock feet while posing', category: 'View', checked: () => app.settings.lockFeet, run: () => app.set('lockFeet', !app.settings.lockFeet) },
  { id: 'view.onion', label: 'Onion skin', category: 'View', keys: ['O'], checked: () => app.settings.onion, run: () => app.set('onion', !app.settings.onion) },
  { id: 'view.trail', label: 'Motion trail', category: 'View', keys: ['T'], checked: () => app.settings.trail, run: () => app.set('trail', !app.settings.trail) },
  {
    id: 'view.ghostOriginal',
    label: 'Ghost: compare with original',
    category: 'View',
    keys: ['G'],
    checked: () => !!app.compareClipId,
    run: () => {
      const c = app.clip;
      if (!c) return;
      if (app.compareClipId) return setCompare(app.compareClipId);
      const orig = c.meta.original ? app.originals.get(c.meta.originalName) : null;
      if (orig && orig !== app.committedClip) setCompare(orig.id);
      else toast('This clip is unedited — right-click any clip › Compare to ghost it');
    },
  },
  { id: 'view.compareWith', label: 'Ghost another clip', category: 'View', hidden: true, run: (id) => setCompare(id) },
  { id: 'view.weights', label: 'Skin weights of selected bone', category: 'View', checked: () => app.settings.weightView, run: () => app.set('weightView', !app.settings.weightView) },
  { id: 'view.allBones', label: 'Show all joints', category: 'View', checked: () => app.settings.showAllBones, run: () => app.set('showAllBones', !app.settings.showAllBones) },
  { id: 'view.skeleton', label: 'Show bone lines', category: 'View', checked: () => app.settings.showSkeleton, run: () => app.set('showSkeleton', !app.settings.showSkeleton) },
  { id: 'view.joints', label: 'Show joints', category: 'View', checked: () => app.settings.showJoints, run: () => app.set('showJoints', !app.settings.showJoints) },
  { id: 'view.mesh', label: 'Show mesh', category: 'View', checked: () => app.settings.showMesh, run: () => app.set('showMesh', !app.settings.showMesh) },
  { id: 'view.parts', label: 'Mesh parts…', category: 'View', enabled: hasModel, run: meshPartsDialog },
  { id: 'view.front', label: 'View front', category: 'View', keys: ['1'], run: () => viewport.view('front') },
  { id: 'view.back', label: 'View back', category: 'View', keys: ['Ctrl+1'], run: () => viewport.view('back') },
  { id: 'view.side', label: 'View side', category: 'View', keys: ['3'], run: () => viewport.view('left') },
  { id: 'view.otherSide', label: 'View other side', category: 'View', keys: ['Ctrl+3'], run: () => viewport.view('right') },
  { id: 'view.top', label: 'View top', category: 'View', keys: ['7'], run: () => viewport.view('top') },
  { id: 'view.persp', label: 'View 3/4', category: 'View', keys: ['0'], run: () => viewport.view('persp') },
  { id: 'view.frame', label: 'Frame selection', category: 'View', keys: ['F'], run: () => viewport.frameSelection() },
  { id: 'panel.pose', label: 'Pose panel', category: 'View', hidden: true, run: () => showTab('pose') },
  { id: 'panel.layers', label: 'Layers panel', category: 'View', hidden: true, run: () => showTab('layers') },
  { id: 'panel.modify', label: 'Modify panel', category: 'View', hidden: true, run: () => showTab('modify') },
  { id: 'bottom.dope', label: 'Dope sheet', category: 'View', keys: ['Ctrl+Shift+D'], run: () => bottom.setTab('dope') },
  { id: 'bottom.graph', label: 'Graph editor', category: 'View', keys: ['Ctrl+Shift+G'], run: () => bottom.setTab('graph') },
  // ---------------------------------------------------------------- help
  { id: 'help.guide', label: 'Getting started', category: 'Help', keys: ['F1'], run: D.guideDialog },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', category: 'Help', keys: ['Shift+?'], run: D.helpDialog },
  { id: 'help.palette', label: 'Command palette', category: 'Help', keys: ['Ctrl+K', 'Ctrl+P'], run: () => palette() },
  {
    id: 'help.about',
    label: 'About AnimStudio',
    category: 'Help',
    run: () =>
      openModal({
        title: 'About AnimStudio',
        body: h('div', { class: 'col' }, h('p', {}, `AnimStudio ${VERSION} — character animation editor for skinned glTF/GLB models.`), h('p', { class: 'muted' }, 'Built on three.js. Files stay on your computer: models are read from the GLB folder, exports and projects are written inside the AnimStudio folder.')),
      }),
  }
);

function structuredCloneLayer(L) {
  const c = cloneClip({ id: 'x', name: '', duration: 0, loop: false, layers: [L], events: [], meta: {} }, true);
  return c.layers[0];
}

async function meshPartsDialog() {
  const parts = app.model.parts;
  const v = await formDialog({
    title: 'Mesh parts',
    intro: 'Hide parts you do not need (hidden parts are skipped when exporting with “only visible parts”).',
    fields: [{ key: 'on', label: 'Visible parts', type: 'checklist', bulk: true, value: parts.map((p, i) => i).filter((i) => !parts[i].hidden), options: parts.map((p, i) => ({ value: i, label: `${p.name} (${p.mesh.geometry.attributes.position.count} verts)` })) }],
  });
  if (!v) return;
  parts.forEach((p, i) => (p.hidden = !v.on.includes(i)));
  viewport.applyVisibility();
}

// =============================================================================
// Menubar
// =============================================================================
const MENUS = [
  ['File', ['file.open', 'file.openFile', 'file.openProject', 'sep', 'file.save', 'file.saveAs', 'sep', 'file.import', 'tools.retarget', 'tools.buildSkeleton', 'file.saveRigged', 'sep', 'file.export', 'file.exportCurrent', 'file.exportClipJson', 'file.showExports', 'sep', 'app.settings']],
  ['Edit', ['edit.undo', 'edit.redo', 'sep', 'edit.copy', 'edit.paste', 'edit.pasteMirror', 'edit.delete', 'sep', 'keys.selectAll', 'keys.selectRange', 'keys.selectSelectedBones', 'range.fromKeys', 'range.clear']],
  ['Clip', ['clip.new', 'clip.duplicate', 'clip.rename', 'clip.delete', 'clip.revert', 'sep', 'clip.toggleLoop', 'clip.addEvent', 'sep', 'tools.speed', 'clip.reverse', 'tools.trim', 'tools.cutRange', 'tools.hold', 'sep', 'clip.mirrorCopy', 'clip.reverseCopy']],
  ['Key', ['key.selected', 'key.all', 'key.deleteAtTime', 'sep', 'keys.interp.smooth', 'keys.interp.linear', 'keys.interp.ease', 'keys.interp.step', 'sep', 'view.autoKey']],
  ['Pose', ['pose.reset', 'pose.copy', 'pose.paste', 'pose.pasteMirror', 'pose.mirrorToOther', 'pose.flip', 'pose.save', 'sep', 'select.parent', 'select.child', 'select.mirror', 'bone.nickname', 'sep', ...GROUPS.filter((g) => g.id !== 'attach').map((g) => `select.${g.id}`)]],
  ['Layers', ['layer.addAdditive', 'layer.addOverride', 'layer.rename', 'layer.duplicate', 'layer.mask', 'layer.up', 'layer.down', 'layer.bake', 'layer.delete']],
  ['Tools', ['tools.moveMaker', 'tools.moveMakerClip', 'sep', ...OPS.map((o) => `op.${o.id}`), 'sep', 'tools.layerClip', 'tools.concat', 'tools.blend', 'tools.keyPoses', 'tools.retarget', 'sep', 'tools.buildSkeleton', 'tools.addSockets', 'tools.props']],
  ['View', ['tool.select', 'tool.rotate', 'tool.move', 'tool.ik', 'tool.space', 'view.lockFeet', 'sep', 'view.onion', 'view.trail', 'view.ghostOriginal', 'view.weights', 'sep', 'view.allBones', 'view.skeleton', 'view.joints', 'view.mesh', 'view.parts', 'sep', 'view.front', 'view.side', 'view.back', 'view.top', 'view.persp', 'view.frame', 'sep', 'bottom.dope', 'bottom.graph', 'timeline.fit', 'play.loop']],
  ['Help', ['help.guide', 'help.shortcuts', 'help.palette', 'sep', 'help.about']],
];

const menubar = $('menubar');
let menuOpenName = null;
function openMenuFor(name, btn) {
  const ids = MENUS.find((m) => m[0] === name)[1];
  const r = btn.getBoundingClientRect();
  menubar.querySelectorAll('button').forEach((b) => b.classList.toggle('open', b === btn));
  menuOpenName = name;
  popupMenu(
    ids.map((id) => {
      if (id === 'sep') return 'sep';
      const c = get(id);
      if (!c) return null;
      return { label: c.label, shortcut: shortcutText(id), run: () => run(id), disabled: !enabled(id), checked: c.checked ? c.checked() : false };
    }),
    r.left,
    r.bottom + 2,
    {
      onClose: () => {
        menuOpenName = null;
        menubar.querySelectorAll('button').forEach((b) => b.classList.remove('open'));
      },
    }
  );
}
for (const [name] of MENUS) {
  const b = h('button', {}, name);
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (menuOpenName === name) closeMenus();
    else openMenuFor(name, b);
  });
  b.addEventListener('pointerenter', () => menuOpenName && menuOpenName !== name && openMenuFor(name, b));
  menubar.append(b);
}

// =============================================================================
// Command palette
// =============================================================================
function palette() {
  if (document.querySelector('.palette')) return;
  const back = h('div', { class: 'modal-back', style: { background: '#05070b80' } });
  const input = h('input', { placeholder: 'Type a command…  (e.g. mirror, export, smooth, onion)' });
  const list = h('div', { class: 'pl' });
  const box = h('div', { class: 'palette' }, input, list);
  back.append(box);
  document.body.append(back);
  let items = [];
  let hl = 0;
  const close = () => back.remove();
  const render = () => {
    const q = input.value.toLowerCase().trim();
    items = all()
      .filter((c) => !c.hidden && (!q || `${c.category} ${c.label}`.toLowerCase().includes(q)))
      .sort((a, b) => (enabled(b.id) ? 1 : 0) - (enabled(a.id) ? 1 : 0))
      .slice(0, 60);
    hl = Math.min(hl, items.length - 1);
    clear(list);
    items.forEach((c, k) =>
      list.append(
        h(
          'div',
          { class: 'pi' + (k === hl ? ' hl' : ''), style: { opacity: enabled(c.id) ? 1 : 0.45 }, onclick: () => (close(), run(c.id)) },
          h('span', { class: 'cat' }, c.category),
          h('span', { class: 'lbl' }, c.label + (c.checked?.() ? '  ✓' : '')),
          c.keys ? h('kbd', {}, c.keys[0]) : null
        )
      )
    );
    list.children[hl]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => ((hl = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (hl = Math.min(items.length - 1, hl + 1)), render(), e.preventDefault();
    else if (e.key === 'ArrowUp') (hl = Math.max(0, hl - 1)), render(), e.preventDefault();
    else if (e.key === 'Enter') {
      const c = items[hl];
      close();
      if (c) run(c.id);
    } else if (e.key === 'Escape') close();
    e.stopPropagation();
  });
  back.addEventListener('pointerdown', (e) => e.target === back && close());
  render();
  input.focus();
}

// =============================================================================
// Keyboard
// =============================================================================
window.addEventListener('keydown', (e) => {
  if (dialogOpen() || document.querySelector('.palette')) return;
  if (isMenuOpen() && e.key === 'Escape') return closeMenus();
  const combo = eventCombo(e);
  if (!combo) return;
  const typing = e.target.matches('input:not([type=checkbox]):not([type=range]):not([type=radio]), textarea, select');
  if (typing && !['Ctrl+S', 'Ctrl+E', 'Ctrl+K'].includes(combo)) return;
  const c = findByCombo(combo);
  if (!c) return;
  e.preventDefault();
  run(c.id);
});

// =============================================================================
// Viewport toolbars, HUD, status bar
// =============================================================================
const vpTools = $('vpToolbar');
const vpView = $('vpViewbar');
function toolBtn(label, id, title) {
  const c = get(id);
  const b = h('button', { title: `${title || c.label}${shortcutText(id) ? ` (${shortcutText(id)})` : ''}`, onclick: () => run(id) }, label);
  b._cmd = c;
  return b;
}
const toolButtons = [
  toolBtn('⬚ Select', 'tool.select'),
  toolBtn('⟳ Rotate', 'tool.rotate'),
  toolBtn('✥ Move', 'tool.move'),
  toolBtn('⤧ IK', 'tool.ik', 'IK: drag hands and feet'),
  h('div', { class: 'vsep' }),
  toolBtn('Lock feet', 'view.lockFeet', 'Keep feet planted while moving hips/spine'),
  toolBtn('Onion', 'view.onion'),
  toolBtn('Trail', 'view.trail', 'Motion trail of the selected joint'),
  toolBtn('Ghost', 'view.ghostOriginal', 'Compare with the original clip'),
  toolBtn('Weights', 'view.weights', 'Show which vertices the selected bone moves'),
];
vpTools.append(...toolButtons);
const viewButtons = [
  toolBtn('Front', 'view.front'),
  toolBtn('Side', 'view.side'),
  toolBtn('Top', 'view.top'),
  toolBtn('3/4', 'view.persp'),
  toolBtn('Frame', 'view.frame'),
  h('div', { class: 'vsep' }),
  h(
    'button',
    {
      title: 'Display options',
      onclick: (e) =>
        popupMenu(
          ['view.mesh', 'view.skeleton', 'view.joints', 'view.allBones', 'view.parts', 'sep', 'app.settings'].map((id) => (id === 'sep' ? 'sep' : { label: get(id).label, checked: get(id).checked?.(), run: () => run(id) })),
          e.clientX - 160,
          e.clientY + 14
        ),
    },
    '⚙ Display'
  ),
];
vpView.append(...viewButtons);
const syncToolbars = () => {
  for (const b of toolButtons) if (b._cmd?.checked) b.classList.toggle('on', !!b._cmd.checked());
};
app.on('settings', syncToolbars);
app.on('view', syncToolbars);
syncToolbars();

const hud = $('vpHud');
const updateHud = rafThrottle(() => {
  if (!app.model) {
    hud.textContent = '';
    return;
  }
  const c = app.clip;
  const L = app.layer;
  const i = app.sel.active;
  clear(hud);
  hud.append(
    h('b', {}, c ? c.name : 'No clip'),
    c ? `   frame ${Math.round(app.time * app.fps)} / ${Math.round(c.duration * app.fps)}${c.loop ? '  ⟲' : ''}` : '',
    L && c?.layers.length > 1 ? `   ·   layer: ${L.name}` : '',
    i >= 0 ? h('div', {}, `● ${boneTitle(app.rig, i, app.nick)}${app.sel.bones.size > 1 ? `  (+${app.sel.bones.size - 1})` : ''}`) : h('div', { class: 'muted' }, 'Click a joint to select · drag to orbit · scroll to zoom')
  );
});
for (const ev of ['time', 'clipSelect', 'clip', 'layer', 'selection', 'model', 'rigNames']) app.on(ev, updateHud);

const pill = $('modelPill');
pill.addEventListener('click', () => run('file.open'));
const updatePill = () => {
  pill.textContent = app.model ? `${app.model.name}${app.project.name ? ` · ${app.project.name}` : ''}${app.project.dirty ? ' •' : ''}` : 'Open a model…';
  document.title = app.model ? `${app.project.dirty ? '• ' : ''}${app.project.name || app.model.name} — AnimStudio` : 'AnimStudio';
};
app.on('project', updatePill);
app.on('model', updatePill);
updatePill();
$('btnExport').addEventListener('click', () => run('file.export'));
$('btnSave').addEventListener('click', () => run('file.save'));
$('btnPalette').addEventListener('click', () => run('help.palette'));

const sb = $('statusbar');
const sbMsg = h('span', { class: 'sb-msg' });
const sbSel = h('span');
const sbHist = h('span');
const sbVer = h('span', {}, `v${VERSION}`);
sb.append(sbMsg, sbSel, sbHist, sbVer);
const updateStatus = rafThrottle(() => {
  sbMsg.textContent = app.status || (app.model ? 'Tip: Ctrl+K searches every command · F1 for the guide' : 'Open a model to begin');
  const nb = app.sel.bones.size;
  const nk = app.keySel.size;
  sbSel.textContent = app.model ? `${nb} bone${nb === 1 ? '' : 's'} · ${nk} key${nk === 1 ? '' : 's'} selected` : '';
  sbHist.textContent = app.history.canUndo ? `Undo: ${app.history.nextUndo}` : '';
});
for (const ev of ['status', 'selection', 'keySel', 'history', 'model']) app.on(ev, updateStatus);
let statusTimer;
app.on('status', () => {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    app.status = '';
    updateStatus();
  }, 6000);
});
updateStatus();

// =============================================================================
// Drag & drop
// =============================================================================
{
  const hint = $('dropHint');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    hint.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hint.classList.add('hidden');
    if (e.target.closest?.('.w-packs')) return; // start page › Animation packs adds them as packs
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const lower = f.name.toLowerCase();
    const fbx = [...e.dataTransfer.files].filter((x) => /\.fbx$/i.test(x.name));
    // No character open yet: an FBX is the character. Otherwise FBX files are animations for it.
    if (fbx.length && !app.model) {
      if (await openModel(await fbx[0].arrayBuffer(), fbx[0].name)) document.getElementById('welcome')?.remove();
      return;
    }
    if (fbx.length) return D.importAnimFiles(fbx); // Mixamo downloads: one or many at once
    if ((lower.endsWith('.glb') || lower.endsWith('.gltf')) && !app.model) {
      if (await openModel(await f.arrayBuffer(), f.name)) document.getElementById('welcome')?.remove();
    } else D.importFile(f);
  });
}

// =============================================================================
// Start
// =============================================================================
app.on('clipSelect', () => {
  if (app.clip && app.settings.rightTab === 'clip') rightPanels.clip.show();
});
document.addEventListener('pointerup', (e) => {
  const b = e.target.closest?.('button');
  if (b) setTimeout(() => b.blur(), 0);
});
startAutosave();
startBridge({ viewport, moveMaker, rigBuilder, bottom, propView });
api.ping().then(() => D.welcome());

// Debug/automation hook.
window.__studio = { app, viewport, bottom, run, openModel, ops };
