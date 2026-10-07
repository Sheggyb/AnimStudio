// Task dialogs: export, retarget, import, combine clips, timing, settings, help, welcome.
import * as THREE from 'three';
import { app } from './state.js';
import { api } from '../io/api.js';
import { exportGLB, eventsSidecar } from '../io/exporter.js';
import { readGLTF, readFBX, buildModel, convertClips, nameMatch } from '../io/loader.js';
import { retargetClip } from '../core/retarget.js';
import * as ops from '../core/ops.js';
import { cloneClip, serializeClip, deserializeClip, clipFromThree } from '../core/clip.js';
import { GROUPS, bonesInSet } from '../core/rig.js';
import { motionProfile, keyPoseTimes } from '../core/analysis.js';
import { formDialog, openModal, alertDialog } from '../ui/dialog.js';
import { h, toast, downloadBlob, fmtBytes, clear } from '../ui/dom.js';
import { busy, openModel, openProjectByName, openProjectJson } from './session.js';
import { all as allCommands, run as runCommand } from './commands.js';
import { packSources } from '../io/packs.js';
import { hooks } from './actions.js';

const ctx = () => ({ rig: app.rig, li: app.layerIndex, fps: app.fps, bones: null, range: null });
const otherClipOptions = () => app.clips.filter((c) => c.id !== app.clipId).map((c) => ({ value: c.id, label: `${c.name} (${Math.round(c.duration * app.fps)}f)` }));
const groupOptions = () => GROUPS.filter((g) => g.id !== 'attach').map((g) => ({ value: g.id, label: g.label, swatch: g.color }));
const maskFromGroups = (ids) => {
  const set = new Set();
  for (const id of ids) for (const i of bonesInSet(app.rig, id)) set.add(app.rig.names[i]);
  return [...set];
};
const baseName = () => app.model.name.replace(/\.(glb|gltf)$/i, '');

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export async function exportDialog({ only = null } = {}) {
  if (!app.model) return toast('Open a model first', 'err');
  const checked = app.clips.filter((c) => app.isExported(c.id));
  const v = await formDialog({
    title: 'Export GLB',
    intro: 'GLB (binary glTF) imports directly into Unity, Unreal, Godot, Blender and web engines. Layers and smooth curves are baked to standard linear keys.',
    ok: 'Export',
    wide: true,
    fields: [
      { key: 'name', label: 'File name', type: 'text', value: only ? `${baseName()}_${only.name}.glb` : `${baseName()}_anim.glb`, full: true },
      {
        key: 'which',
        label: 'Clips',
        type: 'seg',
        value: only ? 'current' : 'checked',
        full: true,
        options: [
          { value: 'checked', label: `Checked (${checked.length})` },
          { value: 'mine', label: `Only my/edited clips` },
          { value: 'current', label: 'Current clip' },
          { value: 'all', label: `All (${app.clips.length})` },
        ],
      },
      { key: 'content', label: 'Content', type: 'seg', value: 'model', options: [{ value: 'model', label: 'Model + animations' }, { value: 'anim', label: 'Animations only (skeleton)' }] },
      { key: 'fps', label: 'Bake rate (fps)', type: 'select', value: '30', options: ['15', '24', '30', '60'] },
      {
        key: 'reduce',
        label: 'Key reduction',
        type: 'seg',
        value: '0',
        full: true,
        options: [
          { value: '0', label: 'Exact' },
          { value: '0.1', label: 'Light' },
          { value: '0.4', label: 'Medium' },
          { value: '1.2', label: 'Strong (small files)' },
        ],
      },
      { key: 'fillRest', type: 'checkbox', text: 'Key every animated bone in every clip (prevents poses leaking between clips in engines)', value: true, full: true },
      { key: 'inPlace', type: 'checkbox', text: 'Remove root motion (in place)', value: false, full: true },
      { key: 'onlyVisible', type: 'checkbox', text: 'Only visible mesh parts', value: true, full: true },
      { key: 'sidecar', type: 'checkbox', text: 'Also write <name>.events.json (loop flags + events for game code)', value: true, full: true },
      { key: 'split', type: 'checkbox', text: 'One file per clip', value: false, full: true },
    ],
  });
  if (!v) return;
  const mineSet = (c) => !c.meta.original || app.originals.get(c.meta.originalName) !== c;
  let clips = v.which === 'current' ? [only || app.clip].filter(Boolean) : v.which === 'all' ? app.clips : v.which === 'mine' ? app.clips.filter(mineSet) : checked;
  if (!clips.length) return toast('No clips to export', 'err');
  let name = v.name.trim() || `${baseName()}_anim.glb`;
  if (!/\.glb$/i.test(name)) name += '.glb';
  const opts = { fps: +v.fps, reduce: +v.reduce, includeMesh: v.content === 'model', onlyVisible: v.onlyVisible, fillRest: v.fillRest, inPlace: v.inPlace };
  const jobs = v.split ? clips.map((c) => ({ clips: [c], name: name.replace(/\.glb$/i, `_${c.name.replace(/[^\w.-]+/g, '_')}.glb`) })) : [{ clips, name }];
  const b = busy('Exporting…');
  const results = [];
  try {
    for (const [k, job] of jobs.entries()) {
      b.set(`Exporting ${job.name} (${k + 1}/${jobs.length})…`);
      await new Promise((r) => setTimeout(r, 20));
      const glb = await exportGLB(app.model, job.clips, opts);
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      results.push(await deliver(blob, job.name));
    }
    if (v.sidecar) {
      const side = new Blob([JSON.stringify(eventsSidecar(app.model, clips), null, 2)], { type: 'application/json' });
      await deliver(side, name.replace(/\.glb$/i, '.events.json'));
    }
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message, 'err');
    return;
  } finally {
    b.close();
    hooks.refreshPose();
  }
  const total = results.reduce((a, r) => a + r.size, 0);
  const first = results.find((r) => r.path);
  await openModal({
    title: 'Export complete',
    body: h(
      'div',
      { class: 'col' },
      h('p', {}, `${clips.length} clip(s) → ${results.length} file(s), ${fmtBytes(total)}.`),
      ...results.map((r) => h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--text2)', wordBreak: 'break-all' } }, r.path || `${r.name} (downloaded)`)),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Unity: drop the .glb into Assets (glTFast / UnityGLTF). Godot: import as a scene; clips appear in the AnimationPlayer. Unreal: Import → glTF. Blender: File › Import › glTF.')
    ),
    buttons: [
      ...(first ? [{ label: 'Show in Explorer', onClick: () => (api.reveal(first.path).catch(() => {}), false) }] : []),
      { label: 'Done', primary: true, value: true },
    ],
  }).result;
}

async function deliver(blob, name) {
  try {
    if (api.online) {
      const r = await api.exportFile(name, blob);
      return { name, path: r.path, size: blob.size };
    }
  } catch {}
  downloadBlob(blob, name);
  return { name, path: null, size: blob.size };
}

export async function exportClipJson() {
  const c = app.clip;
  if (!c) return;
  const blob = new Blob([JSON.stringify({ format: 'animstudio.clip', model: app.model.name, clip: serializeClip(c) })], { type: 'application/json' });
  const r = await deliver(blob, `${baseName()}_${c.name}.clip.json`);
  toast(r.path ? `Saved ${r.path}` : 'Downloaded clip JSON', 'ok');
}

// ---------------------------------------------------------------------------
// Retarget from another model
// ---------------------------------------------------------------------------
async function loadSourceModel(url, name) {
  const b = busy(`Loading ${name}…`);
  try {
    const gltf = await readGLTF(url);
    const model = buildModel(gltf, name, typeof url === 'string' ? url : null);
    return { model, clips: convertClips(model) };
  } finally {
    b.close();
  }
}

function disposeModel(m) {
  m.root.traverse((o) => {
    o.geometry?.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat) => {
      mat?.map?.dispose();
      mat?.dispose();
    });
  });
}

export async function retargetDialog(preloaded = null) {
  if (!app.model) return toast('Open a model first', 'err');
  let src = preloaded;
  if (!src) {
    const models = (await api.models().catch(() => [])).filter((m) => m.name !== app.model.name);
    if (!models.length) return toast('No other models found next to AnimStudio', 'err');
    const v = await formDialog({
      title: 'Retarget animations',
      intro: `Use animations made for another character on ${app.model.name}. Bones are matched by anatomy (arms, legs, spine…), rotations are transferred and hip motion is scaled to the new leg length.`,
      ok: 'Load clips',
      fields: [{ key: 'model', label: 'Source model', type: 'select', value: models[0].url, options: models.map((m) => ({ value: m.url, label: `${m.name}${m.folder === 'Exports' ? ' (export)' : ''}` })), full: true }],
    });
    if (!v) return;
    const m = models.find((x) => x.url === v.model);
    src = await loadSourceModel(m.url, m.name);
  }
  if (!src.model.rig.humanoid || !app.rig.humanoid) toast('Anatomy detection is incomplete on one of the models — results may be partial', 'err');
  const prefix = src.model.name.replace(/\.(glb|gltf)$/i, '').replace(/(Male|Female)$/, '') + '_';
  const v2 = await formDialog({
    title: `Retarget from ${src.model.name}`,
    wide: true,
    ok: 'Retarget',
    fields: [
      { key: 'clips', label: `Clips (${src.clips.length})`, type: 'checklist', bulk: true, value: [], options: src.clips.filter((c) => c.duration > 0).map((c) => ({ value: c.id, label: `${c.name}  ·  ${Math.round(c.duration * 30)}f` })) },
      { key: 'mode', label: 'Matching', type: 'seg', value: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'rotation', label: 'Keep proportions' }, { value: 'direction', label: 'Match limb directions' }], hint: 'Auto picks “Match directions” when the two characters stand differently (e.g. arms down vs T-pose).' },
      { key: 'prefix', label: 'Name prefix', type: 'text', value: prefix },
      { key: 'fingers', type: 'checkbox', text: 'Include fingers', value: true },
      { key: 'reduce', type: 'checkbox', text: 'Reduce keys (smaller, still accurate)', value: true },
    ],
    validate: (x) => (!x.clips.length ? 'Pick at least one clip' : null),
  });
  if (!v2) {
    if (!preloaded) disposeModel(src.model);
    return;
  }
  const b = busy('Retargeting…');
  let made = 0,
    lastMapped = 0,
    lastMode = '';
  try {
    for (const id of v2.clips) {
      const c = src.clips.find((x) => x.id === id);
      const { clip, mapped, mode: used } = retargetClip(c, src.model.rig, app.rig, { mode: v2.mode, fingers: v2.fingers, tolerance: v2.reduce ? 0.05 : 0, fps: 30, name: v2.prefix + c.name });
      clip.meta.note = `retargeted from ${src.model.name} › ${c.name}`;
      app.addClip(clip, 'Retarget clip', { select: made === 0 });
      lastMapped = mapped;
      lastMode = used;
      made++;
    }
  } finally {
    b.close();
    if (!preloaded) disposeModel(src.model);
  }
  toast(`Retargeted ${made} clip(s) · ${lastMapped} bones matched · ${lastMode === 'direction' ? 'matched limb directions' : 'kept proportions'}`, 'ok');
}

// ---------------------------------------------------------------------------
// Import (GLB / clip JSON / project)
// ---------------------------------------------------------------------------
export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => resolve(inp.files[0] || null));
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 60000);
  });
}

export function pickFiles(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple: true, style: { display: 'none' } });
    inp.addEventListener('change', () => resolve([...inp.files]));
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 60000);
  });
}

/**
 * ＋ Add animations: animation files people downloaded themselves become packs in
 * AnimStudio/animations, so ✦ Moves offers them on every character.
 *  - a .glb that is already a pack (several clips) is copied as it is;
 *  - other files (Mixamo .fbx, single-clip .glb) are grouped by skeleton and added to the pack
 *    with the same skeleton, or to a new one ("Mixamo Pack", "My Pack").
 * Returns true when something was added.
 */
export async function addAnimations(files = null) {
  files ??= await pickFiles('.fbx,.glb');
  if (!files?.length) return false;
  if (!(await api.ping())) {
    toast('Adding animations needs the AnimStudio server: start it with start.bat', 'err');
    return false;
  }
  const { readAnimationFiles, buildPack, packKind } = await import('../io/packbuild.js');
  const { glbInfo } = await import('../io/packs.js');
  const b = busy('Reading animations…');
  const added = [];
  const skipped = [];
  try {
    const packs = await packSources({ refresh: true });
    const taken = new Set(packs.map((p) => p.model.toLowerCase()));
    const freeName = (base) => {
      let n = `${base}.glb`;
      for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${base} ${k}.glb`;
      taken.add(n.toLowerCase());
      return n;
    };
    const loose = [];
    for (const f of files) {
      if (!/\.(fbx|glb)$/i.test(f.name)) {
        skipped.push(`${f.name}: not an .fbx or .glb file`);
        continue;
      }
      const buffer = await f.arrayBuffer();
      if (/\.glb$/i.test(f.name)) {
        let info = null;
        try {
          info = glbInfo(buffer);
        } catch {}
        if (info && info.joints && info.clips.filter((c) => c.duration > 0).length >= 2) {
          // Already a pack: keep the file as it is.
          const name = taken.has(f.name.toLowerCase()) ? f.name : freeName(f.name.replace(/\.glb$/i, ''));
          b.set(`Saving ${name}…`);
          await api.savePack(name, new Blob([buffer]));
          taken.add(name.toLowerCase());
          added.push(`${name.replace(/\.glb$/i, '')} (${info.clips.filter((c) => c.duration > 0 && !/t_?pose/i.test(c.name)).length} moves)`);
          continue;
        }
      }
      loose.push({ name: f.name, buffer });
    }
    if (loose.length) {
      const { groups, skipped: bad } = await readAnimationFiles(loose, { onProgress: (k, n) => b.set(`Reading ${n} (${k + 1}/${loose.length})…`) });
      skipped.push(...bad.map((x) => `${x.name}: ${x.error}`));
      for (const g of groups) {
        const same = packs.find((p) => p.bones?.length && [...g.bones].filter((n) => !p.bones.includes(n)).length <= 2);
        const name = same ? same.model : freeName(`${packKind(g.bones)} Pack`);
        b.set(`${same ? 'Adding to' : 'Building'} ${name} (${g.clips.length} moves)…`);
        const mergeWith = same ? await (await fetch(same.url, { cache: 'no-store' })).arrayBuffer() : null;
        const glb = await buildPack(g, { mergeWith });
        await api.savePack(name, new Blob([glb], { type: 'model/gltf-binary' }));
        added.push(`${g.clips.length} move${g.clips.length === 1 ? '' : 's'} → ${name.replace(/\.glb$/i, '')}`);
      }
    }
  } catch (e) {
    console.error(e);
    skipped.push(e.message);
  } finally {
    b.close();
  }
  await packSources({ refresh: true });
  if (added.length) toast(`Added ${added.join(', ')}. Open a character and press ✦ Moves.`, 'ok', { ms: 8000 });
  if (skipped.length) toast('Not added: ' + skipped.join('; '), 'err', { ms: 10000 });
  return added.length > 0;
}

/**
 * Animation files from other skeletons (Mixamo FBX downloads, with or without skin): every
 * clip is retargeted onto the current character straight away, named after its file.
 */
export async function importAnimFiles(files) {
  if (!app.model) return toast('Open your character first, then drop the animation files', 'err');
  const b = busy('Reading animations…');
  let made = 0;
  const failed = [];
  try {
    for (const [k, file] of files.entries()) {
      b.set(`Adding ${file.name} (${k + 1}/${files.length})…`);
      try {
        const lower = file.name.toLowerCase();
        const buf = await file.arrayBuffer();
        const gltf = lower.endsWith('.fbx') ? await readFBX(buf) : await readGLTF(buf);
        if (!gltf.animations.length) throw new Error('no animation in this file');
        const model = buildModel(gltf, file.name);
        const base = file.name.replace(/\.(fbx|glb|gltf)$/i, '').replace(/[_-]+/g, ' ').trim();
        const clips = convertClips(model, gltf.animations, { source: 'imported' }).filter((c) => c.duration > 0);
        for (const c of clips) {
          // Mixamo names every clip "mixamo.com"; the file name says what it is.
          const name = clips.length === 1 || /mixamo|^take|^anim|^clip/i.test(c.name) ? base : `${base} ${c.name}`;
          const { clip } = retargetClip(c, model.rig, app.rig, { mode: 'auto', tolerance: 0.05, fps: 30, name });
          clip.loop = c.loop;
          clip.meta.note = `imported from ${file.name}`;
          app.addClip(clip, 'Import animation', { select: made === 0 });
          made++;
        }
        disposeModel(model);
      } catch (e) {
        console.error(e);
        failed.push(`${file.name}: ${e.message}`);
      }
    }
  } finally {
    b.close();
  }
  if (made) toast(`Added ${made} animation${made > 1 ? 's' : ''} to ${app.model.name.replace(/\.(glb|gltf)$/i, '')}${failed.length ? ` · ${failed.length} failed` : ''}`, 'ok');
  if (failed.length) toast('Could not import: ' + failed.join('; '), 'err', { ms: 8000 });
}

export async function importFile(file) {
  if (!file) file = await pickFile('.glb,.gltf,.json,.fbx');
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.fbx')) return importAnimFiles([file]);
  try {
    if (lower.endsWith('.json')) {
      const json = JSON.parse(await file.text());
      if (json.format === 'animstudio.project') return openProjectJson(json, file.name.replace(/\.animproj\.json$/i, ''));
      if (!app.model) return toast('Open a model first', 'err');
      let clips = [];
      if (json.format === 'animstudio.clip') clips = [deserializeClip(json.clip)];
      else {
        const arr = Array.isArray(json) ? json : [json];
        clips = arr.map((j) => clipFromThree(THREE.AnimationClip.parse(j), new Set(app.rig.names), { source: 'imported' }));
      }
      clips.forEach((c, k) => {
        c.id = 'C' + Math.random().toString(36).slice(2, 10);
        c.meta = { ...c.meta, source: 'imported', original: false };
        app.addClip(c, 'Import clip', { select: k === 0 });
      });
      return toast(`Imported ${clips.length} clip(s)`, 'ok');
    }
    const buf = await file.arrayBuffer();
    if (!app.model) return openModel(buf, file.name);
    const b = busy(`Reading ${file.name}…`);
    let gltf;
    try {
      gltf = await readGLTF(buf);
    } finally {
      b.close();
    }
    const match = nameMatch(app.rig, gltf.animations);
    if (gltf.animations.length && match > 0.9) {
      const clips = convertClips(app.model, gltf.animations, { source: 'imported' });
      const v = await formDialog({
        title: `Import from ${file.name}`,
        intro: 'This file uses the same skeleton — clips can be imported directly.',
        ok: 'Import',
        fields: [{ key: 'ids', label: 'Clips', type: 'checklist', bulk: true, value: clips.map((c) => c.id), options: clips.map((c) => ({ value: c.id, label: c.name })) }],
      });
      if (!v) return;
      clips.filter((c) => v.ids.includes(c.id)).forEach((c, k) => app.addClip(c, 'Import clip', { select: k === 0 }));
      toast(`Imported ${v.ids.length} clip(s)`, 'ok');
    } else {
      // Different skeleton: offer retargeting.
      const model = buildModel(gltf, file.name);
      await retargetDialog({ model, clips: convertClips(model) });
      disposeModel(model);
    }
  } catch (e) {
    console.error(e);
    toast('Import failed: ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Combine clips
// ---------------------------------------------------------------------------
export async function layerClipDialog() {
  if (!app.clip) return;
  const opts = otherClipOptions();
  if (!opts.length) return toast('Need another clip to layer', 'err');
  const v = await formDialog({
    title: 'Layer another clip on top',
    intro: `Adds a new layer to “${app.clip.name}” that plays another clip on the chosen body parts — e.g. an attack on the upper body over a run.`,
    fields: [
      { key: 'src', label: 'Clip to layer', type: 'select', value: opts[0].value, options: opts, full: true },
      { key: 'mask', label: 'Body parts', type: 'checklist', value: ['torso', 'head', 'arm.L', 'arm.R'], options: groupOptions(), bulk: true },
      { key: 'mode', label: 'Mode', type: 'seg', value: 'override', options: [{ value: 'override', label: 'Replace' }, { value: 'additive', label: 'Add on top' }] },
      { key: 'timing', label: 'Timing', type: 'seg', value: 'stretch', options: [{ value: 'stretch', label: 'Stretch to fit' }, { value: 'loop', label: 'Loop' }, { value: 'asis', label: 'As is' }] },
      { key: 'weight', label: 'Weight', type: 'range', min: 0, max: 1, step: 0.05, value: 1 },
      { key: 'newClip', type: 'checkbox', text: 'Create a new baked clip instead of adding a layer', value: false },
    ],
    validate: (x) => (!x.mask.length ? 'Choose at least one body part' : null),
  });
  if (!v) return;
  const src = app.clips.find((c) => c.id === v.src);
  const params = { mode: v.mode, mask: maskFromGroups(v.mask), weight: v.weight, timing: v.timing, fps: app.fps, name: `${src.name} layer` };
  if (v.newClip) {
    const c = cloneClip(app.clip, true);
    ops.addClipAsLayer(c, src, ctx(), params);
    ops.bakeLayers(c, ctx(), { fps: app.fps });
    c.name = `${app.clip.name}+${src.name}`;
    c.meta = { source: 'derived', note: `${app.clip.name} with ${src.name} on ${v.mask.join(', ')}` };
    app.addClip(c, 'Combine clips');
  } else {
    let id;
    app.edit('Layer clip', (d) => (id = ops.addClipAsLayer(d, src, ctx(), params).id));
    app.setLayer(id);
  }
  toast('Clip layered', 'ok');
}

export async function concatDialog() {
  if (!app.clip) return;
  const opts = otherClipOptions();
  if (!opts.length) return toast('Need another clip', 'err');
  const v = await formDialog({
    title: 'Chain clips',
    intro: `Creates a new clip: “${app.clip.name}” followed by another clip, with a smooth crossfade.`,
    fields: [
      { key: 'b', label: 'Then play', type: 'select', value: opts[0].value, options: opts, full: true },
      { key: 'blend', label: 'Crossfade (frames)', type: 'range', min: 0, max: 30, step: 1, value: 6 },
      { key: 'name', label: 'Name', type: 'text', value: '' },
    ],
  });
  if (!v) return;
  const b = app.clips.find((c) => c.id === v.b);
  const c = ops.concatClips(app.clip, b, ctx(), { blend: v.blend, fps: app.fps, name: v.name || `${app.clip.name}_then_${b.name}` });
  app.addClip(c, 'Chain clips');
  toast(`Created ${c.name}`, 'ok');
}

export async function blendDialog() {
  if (!app.clip) return;
  const opts = otherClipOptions();
  if (!opts.length) return toast('Need another clip', 'err');
  const v = await formDialog({
    title: 'Blend two clips',
    intro: 'Mixes two motions over normalised time — e.g. Walk + Run → jog, Stand + Ready → alert idle. Works best with similar timing.',
    fields: [
      { key: 'b', label: `Blend “${app.clip.name}” with`, type: 'select', value: opts[0].value, options: opts, full: true },
      { key: 'w', label: 'Mix (0 = this clip, 1 = other)', type: 'range', min: 0, max: 1, step: 0.05, value: 0.5 },
      { key: 'name', label: 'Name', type: 'text', value: '' },
    ],
  });
  if (!v) return;
  const b = app.clips.find((c) => c.id === v.b);
  const c = ops.blendClips(app.clip, b, ctx(), { weight: v.w, fps: app.fps, name: v.name || `${app.clip.name}_${b.name}_mix` });
  app.addClip(c, 'Blend clips');
  toast(`Created ${c.name}`, 'ok');
}

export async function keyPosesDialog() {
  const clip = app.clip;
  if (!clip || clip.duration <= 0) return;
  const prof = motionProfile(clip, app.rig, { fps: app.fps });
  const preview = (v) => {
    app.keyPoses = { clipId: clip.id, times: keyPoseTimes(prof, { minGap: v.gap / app.fps, maxPoses: v.max }) };
    app.emit('timeview');
  };
  const v = await formDialog({
    title: 'Key poses',
    side: true,
    intro: 'Animators work pose-to-pose: a few strong poses, then in-betweens. This finds the moments where the body is momentarily still (extremes, contacts) — shown as pink marks on the timeline — and can build a clean pose-to-pose version that is easy to edit.',
    fields: [
      { key: 'gap', label: 'Minimum spacing (frames)', type: 'range', min: 2, max: 30, step: 1, value: 6 },
      { key: 'max', label: 'Maximum poses', type: 'range', min: 3, max: 40, step: 1, value: 16 },
      { key: 'make', type: 'checkbox', text: 'Create a pose-to-pose copy (smooth keys only at the key poses)', value: true },
    ],
    ok: 'OK',
    onChange: preview,
  });
  if (!v) return;
  preview(v);
  if (v.make) {
    const c = ops.keyPosesClip(clip, ctx(), app.keyPoses.times, { name: `${clip.name}_poses` });
    app.addClip(c, 'Key pose clip');
    app.keyPoses = { clipId: c.id, times: app.keyPoses.times };
    toast(`Created ${c.name} with ${app.keyPoses.times.length} key poses`, 'ok');
  }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export async function speedDialog() {
  const clip = app.clip;
  if (!clip) return;
  const frames = Math.round(clip.duration * app.fps);
  let base = clip;
  app.beginLive('Change speed');
  const v = await formDialog({
    title: 'Speed / length',
    side: true,
    intro: `Currently ${frames} frames (${clip.duration.toFixed(2)}s). Keys are stretched or squashed in time.`,
    fields: [
      { key: 'mode', label: 'Set by', type: 'seg', value: 'speed', options: [{ value: 'speed', label: 'Speed' }, { value: 'frames', label: 'Length' }] },
      { key: 'speed', label: 'Speed (2 = twice as fast)', type: 'range', min: 0.2, max: 4, step: 0.05, value: 1, show: (x) => x.mode === 'speed' },
      { key: 'frames', label: 'Length (frames)', type: 'number', min: 1, step: 1, value: frames, show: (x) => x.mode === 'frames' },
    ],
    onChange: (x) => app.updateLive((d) => (x.mode === 'speed' ? ops.scaleTime(d, 1 / Math.max(0.05, x.speed)) : ops.setDuration(d, Math.max(1, x.frames) / app.fps, true))),
  });
  if (!v) return app.cancelLive();
  app.commitLive('Change speed');
  app.setTime(Math.min(app.time, app.duration));
}

export async function holdDialog() {
  if (!app.clip) return;
  const v = await formDialog({
    title: 'Insert hold',
    intro: `Freezes the pose at frame ${Math.round(app.time * app.fps)} — everything after moves later. Great for dramatic pauses and anticipation.`,
    fields: [{ key: 'frames', label: 'Hold length (frames)', type: 'range', min: 1, max: 60, step: 1, value: 6 }],
  });
  if (!v) return;
  app.edit('Insert hold', (d) => ops.insertHold(d, app.time, v.frames / app.fps));
}

// ---------------------------------------------------------------------------
// Settings / help / welcome
// ---------------------------------------------------------------------------
export async function settingsDialog() {
  const s = app.settings;
  const v = await formDialog({
    title: 'Preferences',
    ok: 'Save',
    fields: [
      { key: 'interp', label: 'Interpolation for new keys', type: 'select', value: String(s.interp), options: [{ value: '1', label: 'Smooth' }, { value: '0', label: 'Linear' }, { value: '2', label: 'Ease in/out' }, { value: '3', label: 'Step' }] },
      { key: 'autosaveSec', label: 'Autosave every (seconds)', type: 'number', min: 10, max: 600, step: 5, value: s.autosaveSec },
      { key: 'onionBefore', label: 'Onion skin: ghosts before', type: 'number', min: 0, max: 6, step: 1, value: s.onionBefore },
      { key: 'onionAfter', label: 'Onion skin: ghosts after', type: 'number', min: 0, max: 6, step: 1, value: s.onionAfter },
      { key: 'onionStep', label: 'Onion skin: frames between ghosts', type: 'number', min: 1, max: 30, step: 1, value: s.onionStep },
      { key: 'jointScale', label: 'Joint size', type: 'range', min: 0.4, max: 2.5, step: 0.05, value: s.jointScale },
      { key: 'gizmoSize', label: 'Gizmo size', type: 'range', min: 0.4, max: 2, step: 0.05, value: s.gizmoSize },
      { key: 'shadows', type: 'checkbox', text: 'Ground shadows', value: s.shadows },
      { key: 'alphaCut', type: 'checkbox', text: 'Alpha cutout for hair/cloth textures', value: s.alphaCut },
    ],
  });
  if (!v) return;
  for (const [k, val] of Object.entries(v)) app.set(k, typeof s[k] === 'number' ? +val : val);
}

export function helpDialog() {
  const cmds = allCommands().filter((c) => c.keys?.length);
  const cats = [...new Set(cmds.map((c) => c.category))];
  openModal({
    title: 'Keyboard shortcuts',
    wide: true,
    body: h(
      'div',
      { class: 'help-cols' },
      cats.map((cat) => [h('h4', {}, cat), ...cmds.filter((c) => c.category === cat).map((c) => h('div', { class: 'hk' }, h('span', {}, c.label), h('kbd', {}, c.keys.join(' / '))))]),
      h('h4', {}, 'Viewport'),
      ...[
        ['Orbit / pan / zoom', 'Left / Right / Wheel'],
        ['Select joint (add / toggle)', 'Click (Shift / Ctrl)'],
        ['Frame joint', 'Double-click'],
      ].map(([a, b]) => h('div', { class: 'hk' }, h('span', {}, a), h('kbd', {}, b))),
      h('h4', {}, 'Dope sheet & graph'),
      ...[
        ['Scrub', 'Drag ruler'],
        ['Set range', 'Shift+drag ruler'],
        ['Move / scale keys', 'Drag / Alt+drag'],
        ['Box select', 'Drag empty area'],
        ['Zoom time', 'Ctrl+Wheel'],
        ['Pan time', 'Shift+Wheel / Middle drag'],
        ['Zoom values (graph)', 'Wheel'],
      ].map(([a, b]) => h('div', { class: 'hk' }, h('span', {}, a), h('kbd', {}, b)))
    ),
  });
}

export function guideDialog() {
  openModal({
    title: 'Getting started',
    wide: true,
    body: h(
      'div',
      { class: 'guide' },
      h('h4', {}, '1 · Study existing animations'),
      h('p', {}, 'Pick a clip on the left and press Space. Hover joints to see their names, click one, then open the Graph Editor to see how it rotates over time. The Clip tab shows which body parts do the most work, whether the clip loops cleanly and where its key poses are. Turn on Onion skin (O) or the Trail (T) to see motion over time.'),
      h('h4', {}, '2 · Change an existing animation (non-destructively)'),
      h('ul', {}, h('li', {}, 'Layers tab › + Additive layer, then pose bones: your tweak is added on top. One key = change for the whole clip; more keys = change that varies over time.'), h('li', {}, 'Modify tab: Exaggerate, Smooth, Add life (noise), Overlap, Mirror, Speed… every modifier previews live and can be limited to selected bones or a time range (Shift+drag on the ruler).'), h('li', {}, 'Dense captured clips have a key on every frame — “Simplify to N fps” or “Key poses” make them easy to edit by hand.')),
      h('h4', {}, '3 · Create new animations'),
      h('ul', {}, h('li', {}, 'Easiest: ✦ Moves — pick a ready move from the animation packs, adjust it with sliders, add it, then pose it to make it yours.'), h('li', {}, 'Shift+N (or + New in Clips) creates a clip from the current pose. Move the playhead, pose, and auto-key records keys. Use IK (I) to drag hands and feet; Lock feet keeps them planted while you move the hips.'), h('li', {}, 'Save poses to the library and reuse them; Paste mirrored for the other side; Chain/Blend/Layer clips in the Modify tab; Drop Mixamo .fbx files to add them as clips. Joint in the wrong place? Rig tab › ✎ Edit skeleton (clips are kept).')),
      h('h4', {}, '4 · Use it in your game'),
      h('p', {}, 'Ctrl+E exports a GLB with the model and your clips (or animations only). Events you add in the Clip tab are written into the file and a .events.json sidecar. Save the project (Ctrl+S) to continue later; work is autosaved.')
    ),
  });
}

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
};
// "Meshy_AI_Grinblade_Bot_1004210611_texture_rigged.glb" -> "Grinblade Bot" (file names stay as they are)
const prettyModel = (n) =>
  n
    .replace(/\.(glb|gltf|fbx|animproj\.json)$/i, '')
    .replace(/^Meshy_AI_/i, '')
    .replace(/_\d{6,}(?:_(?:texture|generate|refine))?/i, '')
    .replace(/_rigged\b/i, '')
    .replace(/_/g, ' ')
    .trim();
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name) => h('div', { class: 'w-avatar', style: { background: `linear-gradient(135deg, hsl(${hue(name)} 45% 32%), hsl(${(hue(name) + 40) % 360} 50% 22%))` } }, name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?');

export async function welcome() {
  document.getElementById('welcome')?.remove();
  const [models, projects] = await Promise.all([api.models().catch(() => []), api.projects().catch(() => [])]);
  const close = () => el.remove();
  const open = async (fn) => {
    if (await fn()) close();
  };
  const mine = models;
  const openFile = () =>
    open(async () => {
      const f = await pickFile('.glb,.gltf,.fbx');
      return f && openModel(await f.arrayBuffer(), f.name);
    });

  const projectCard = (p) => {
    const name = p.name.replace(/\.animproj\.json$/i, '');
    const title = prettyModel(name);
    const del = h('button', {
      class: 'w-del ghost icon',
      title: 'Delete project',
      onclick: async (e) => {
        e.stopPropagation();
        const { confirmDialog } = await import('../ui/dialog.js');
        if (!(await confirmDialog('Delete project', `Delete the project "${name}"? The character model is not affected.`, { ok: 'Delete', danger: true }))) return;
        await api.deleteProject(p.name);
        welcome();
      },
    }, '✕');
    return h(
      'div',
      { class: 'w-project', role: 'button', tabIndex: 0, title: `Open ${name}`, onclick: () => open(async () => (await openProjectByName(p.name), true)) },
      p.thumb ? h('img', { class: 'w-thumb', src: p.thumb, alt: '' }) : h('div', { class: 'w-thumb' }, avatar(title)),
      h('div', { class: 'w-info' }, h('div', { class: 'w-title' }, title), h('div', { class: 'w-sub' }, p.model ? prettyModel(p.model) : 'unknown model'), h('div', { class: 'w-meta' }, [p.clips != null ? `${p.clips} clip${p.clips === 1 ? '' : 's'}` : null, ago(p.mtime)].filter(Boolean).join(' · '))),
      del
    );
  };
  const modelCard = (m, compact = false) =>
    h(
      'button',
      { class: compact ? 'w-chip' : 'w-model', title: m.name, onclick: () => open(() => openModel(m.url, m.name)) },
      compact ? null : avatar(prettyModel(m.name)),
      h('div', { class: 'w-info' }, h('div', { class: 'w-title' }, prettyModel(m.name)), compact ? null : h('div', { class: 'w-meta' }, [/_rigged\.glb$/i.test(m.name) ? 'rigged' : m.folder === 'Exports' ? 'export' : 'model', fmtBytes(m.size), ago(m.mtime)].join(' · ')))
    );
  const section = (title, note, body) => h('section', { class: 'w-section' }, h('div', { class: 'w-head' }, h('h2', {}, title), note ? h('span', { class: 'muted' }, note) : null), body);

  // Animation packs (AnimStudio/animations): ready moves for ✦ Moves. People bring their own
  // (Mixamo, Quaternius, …) with ＋ Add animations or by dropping files on this section.
  const add = async (files) => (await addAnimations(files)) && welcome();
  const addCard = h(
    'button',
    { class: 'w-model w-add', title: 'Add animation files you downloaded (Mixamo .fbx, packs as .glb)', onclick: () => add() },
    h('div', { class: 'w-avatar' }, '＋'),
    h('div', { class: 'w-info' }, h('div', { class: 'w-title' }, 'Add animations'), h('div', { class: 'w-meta' }, '.fbx or .glb — or drop them here'))
  );
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const whereToGet = h(
    'div',
    { class: 'w-empty w-howto' },
    h('b', {}, 'No animations yet. Free places to get them:'),
    h(
      'ul',
      {},
      h('li', {}, link('https://www.mixamo.com', 'Mixamo'), ' (free Adobe account): pick a move, Download → Format FBX, 30 fps, tick ', h('i', {}, 'In Place'), ' for walks and runs. Any Mixamo character works.'),
      h('li', {}, link('https://quaternius.com', 'Quaternius'), ': the free (CC0) ', h('i', {}, 'Universal Animation Library'), ' packs; add the .glb as it is.')
    ),
    h('span', { class: 'muted' }, 'Then press ＋ Add animations or drop the files here. They are saved in AnimStudio/animations and work on every character.')
  );
  const packGrid = h('div', { class: 'w-models' }, addCard, h('div', { class: 'w-empty' }, 'Reading animation packs…'));
  const packsSection = section('Animation packs', 'moves for every character — open a character, then ✦ Moves', h('div', {}, packGrid));
  packsSection.addEventListener('dragover', (e) => (e.preventDefault(), packsSection.classList.add('w-dropping')));
  packsSection.addEventListener('dragleave', (e) => !packsSection.contains(e.relatedTarget) && packsSection.classList.remove('w-dropping'));
  packsSection.classList.add('w-packs'); // main.js leaves drops here to us
  packsSection.addEventListener('drop', (e) => {
    // Files dropped here are animations, never a character to open.
    e.preventDefault();
    packsSection.classList.remove('w-dropping');
    add([...e.dataTransfer.files]);
  });
  packSources()
    .then((packs) => {
      clear(packGrid);
      packGrid.append(addCard);
      if (!packs.length) return packsSection.append(whereToGet);
      for (const p of packs) {
        const moves = p.clips.filter((c) => c.duration > 0 && !/t_?pose/i.test(c.name)).length;
        const del = h('button', {
          class: 'w-del ghost icon',
          title: 'Remove this pack',
          onclick: async (e) => {
            e.stopPropagation();
            const { confirmDialog } = await import('../ui/dialog.js');
            if (!(await confirmDialog('Remove pack', `Remove "${p.label}" from AnimStudio/animations? Clips you already added to characters stay.`, { ok: 'Remove', danger: true }))) return;
            await api.deletePack(p.model);
            await packSources({ refresh: true });
            welcome();
          },
        }, '✕');
        packGrid.append(
          h(
            'div',
            {
              class: 'w-model w-pack',
              role: 'button',
              tabIndex: 0,
              title: `${p.model} — click to browse its moves on your character`,
              onclick: async () => {
                if (!app.model) {
                  const last = mine.sort((a, b) => b.mtime - a.mtime)[0];
                  if (!last) return toast('Open a character first (drop a .glb), then press ✦ Moves', 'err');
                  if (!(await openModel(last.url, last.name))) return;
                }
                close();
                runCommand('tools.moveMaker');
              },
            },
            h('div', { class: 'w-avatar', style: { background: 'linear-gradient(135deg, #7c3aed, #312e81)' } }, '✦'),
            h('div', { class: 'w-info' }, h('div', { class: 'w-title' }, p.label), h('div', { class: 'w-meta' }, `${moves} moves`)),
            del
          )
        );
      }
    })
    .catch(() => (clear(packGrid), packGrid.append(addCard, h('div', { class: 'w-empty' }, 'Could not read the animation packs.'))));

  const el = h(
    'div',
    { class: 'welcome', id: 'welcome' },
    h(
      'div',
      { class: 'welcome-inner' },
      h(
        'header',
        { class: 'w-top' },
        h('div', { class: 'grow' }, h('h1', {}, 'Anim', h('span', {}, 'Studio')), h('p', { class: 'lead' }, 'Rig, animate and export characters for your game.')),
        h('button', { class: 'primary', onclick: openFile }, 'Open .glb / .fbx…'),
        app.model ? h('button', { onclick: close }, 'Back to editor') : null
      ),
      projects.length
        ? section(
            'Continue',
            `${projects.length} project${projects.length === 1 ? '' : 's'}`,
            h('div', { class: 'w-projects' }, projects.sort((a, b) => b.mtime - a.mtime).map(projectCard))
          )
        : null,
      section(
        'My characters',
        'rigged models and exports',
        mine.length
          ? h('div', { class: 'w-models' }, mine.sort((a, b) => b.mtime - a.mtime).map((m) => modelCard(m)))
          : h('div', { class: 'w-empty' }, 'No characters yet. Open a .glb (or drop one anywhere), then Tools › Build skeleton — the rigged model is saved here.')
      ),
      h('div', { class: 'w-drop', onclick: openFile }, h('b', {}, 'Drop a character (.glb or .fbx) anywhere'), h('span', { class: 'muted' }, 'or click to browse — Meshy, Blender, Mixamo exports… With a character open, drop Mixamo animations (.fbx) to add them.')),
      packsSection,
      !models.length && !api.online ? h('div', { class: 'w-empty' }, 'Server not reachable — start AnimStudio with start.bat. You can still drop a .glb file here.') : null,
      h(
        'details',
        { class: 'w-features' },
        h('summary', {}, 'What you can do'),
        h(
          'div',
          { class: 'feature-grid' },
          [
            ['✦ Moves', 'Pick a ready move from the animation packs, preview it on your character, adjust it with sliders and add it.'],
            ['Make it yours', 'Pose any frame of an added move — your changes go on a “My edits” layer on top, the original stays intact.'],
            ['Mixamo', 'Drop Mixamo .fbx downloads on the window: each becomes a clip on your character.'],
            ['Build skeleton', 'Give an unrigged model (Meshy, sculpts) a game skeleton with weapon sockets in a minute.'],
            ['IK posing', 'Drag hands and feet; lock feet while moving the hips; mirror and flip poses.'],
            ['Modifiers & layers', 'Exaggerate, smooth, loop-fix, speed, root motion; additive and override layers with masks.'],
          ].map(([t, d]) => h('div', { class: 'feature' }, h('b', {}, t), d))
        )
      )
    )
  );
  document.body.append(el);
}
