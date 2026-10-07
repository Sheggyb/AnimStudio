// Session: opening models, projects, autosave & recovery.
import { app } from './state.js';
import { api } from '../io/api.js';
import { readGLTF, readFBX, buildModel, convertClips } from '../io/loader.js';
import { serializeProject, deserializeProject } from '../core/project.js';
import { makeClip, cloneClip } from '../core/clip.js';
import { exportGLB } from '../io/exporter.js';
import { addSockets } from '../io/sockets.js';
import { hooks } from './actions.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { toast, h } from '../ui/dom.js';

let busyEl = null;
export function busy(msg) {
  if (!busyEl) {
    busyEl = h('div', { class: 'modal-back', style: { zIndex: 1200 } }, h('div', { class: 'card', style: { padding: '16px 22px', fontSize: '14px' } }, h('span', { class: 'busy-msg' })));
  }
  busyEl.querySelector('.busy-msg').textContent = msg;
  document.body.append(busyEl);
  return { close: () => busyEl.remove(), set: (m) => (busyEl.querySelector('.busy-msg').textContent = m) };
}

export async function confirmDiscard(what = 'open another model') {
  if (!app.project.dirty) return true;
  return confirmDialog('Unsaved changes', `You have unsaved changes. Discard them and ${what}? (They are also kept in the autosave.)`, { ok: 'Discard', danger: true });
}

/** Load a character. source: URL or ArrayBuffer. */
export async function openModel(source, name, { project = null, skipConfirm = false } = {}) {
  if (!skipConfirm && !(await confirmDiscard())) return false;
  const b = busy(`Loading ${name}…`);
  try {
    if (app.project.dirty && app.model) await autosaveNow();
    const isFBX = typeof source !== 'string' && /\.fbx$/i.test(name);
    const gltf = isFBX ? await readFBX(source) : await readGLTF(source);
    if (isFBX) gltf.animations = gltf.animations.filter((a) => a.tracks.length && a.duration > 0.1); // FBX "Take 001" / 1-frame stubs
    b.set('Analysing skeleton…');
    const model = buildModel(gltf, name, typeof source === 'string' ? source : null);
    const clips = convertClips(model);
    const starter = !clips.length && !project;
    if (starter) {
      // Nothing to play yet: give the user an empty clip to pose into right away.
      const c = makeClip('Animation 1', 2);
      c.meta = { source: 'new', note: 'starter clip — pose the model and keys are recorded' };
      clips.push(c);
    }
    app.setModel(model, clips);
    document.getElementById('welcome')?.remove();
    if (isFBX) {
      // AnimStudio works on GLB: keep a converted copy in AnimStudio/models so the character
      // shows up on the start page, projects can reopen it, and Godot export works as usual.
      b.set('Saving a GLB copy…');
      try {
        const r = await saveRiggedModel({ quiet: true, file: `${name.replace(/\.fbx$/i, '')}.glb` });
        toast(`Converted ${name} → models/${r.file} (open that one from now on)`, 'ok', { ms: 8000 });
      } catch (e) {
        toast('Opened, but could not save a GLB copy: ' + e.message, 'err');
      }
    }
    if (project) applyProject(project);
    else checkAutosave();
    const rig = model.rig;
    if (model.synthetic)
      toast(`${name} has no skeleton. Parts can be animated as-is — or build a full body skeleton to make it walk.`, '', {
        ms: 15000,
        action: { label: 'Build skeleton…', run: () => import('./commands.js').then((c) => c.run('tools.buildSkeleton')) },
      });
    else if (!rig.humanoid)
      toast(`${name}: arms/legs not recognised. Build a skeleton from joint markers to retarget walks and runs.`, '', {
        ms: 12000,
        action: { label: 'Build skeleton…', run: () => import('./commands.js').then((c) => c.run('tools.buildSkeleton')) },
      });
    else toast(`${name}: ${rig.bones.length} bones, ${clips.length - (starter ? 1 : 0)} clips${rig.humanoid ? ' · anatomy detected' : ''}`, 'ok');
    if (starter) toast('No animations in this file — “Animation 1” is ready: pick a joint, pose it, move the playhead, pose again.', '', { ms: 9000 });
    return true;
  } catch (e) {
    console.error(e);
    toast(`Could not open ${name}: ${e.message}`, 'err');
    return false;
  } finally {
    b.close();
  }
}

export function projectData() {
  return serializeProject({
    model: app.model.name,
    clips: app.clips,
    originals: app.originals,
    excluded: app.excluded,
    nick: app.project.nick,
    poses: app.project.poses,
    props: app.project.props,
    settings: { fps: app.fps },
  });
}

export function applyProject(json) {
  const r = deserializeProject(json, app.originals);
  if (r.missing.length) toast(`${r.missing.length} original clip(s) referenced by the project were not found in the model`, 'err');
  app.clips = r.clips;
  app.excluded = r.excluded;
  app.project.nick = { ...app.project.nick, ...r.nick };
  app.project.poses = r.poses;
  app.project.props = r.props;
  if (r.settings.fps) app.set('fps', r.settings.fps);
  app.history.clear();
  const first = app.clips.find((c) => !c.meta.original) || app.clips[0];
  app.clipId = first?.id || null;
  app.layerId = first?.layers[0].id || null;
  app.project.dirty = false;
  app.version++;
  for (const ev of ['clips', 'clipSelect', 'poses', 'props', 'project', 'rigNames', 'history']) app.emit(ev);
  app.emit('clip', {});
}

export async function saveProject({ as = false } = {}) {
  if (!app.model) return toast('Nothing to save yet', 'err');
  let name = app.project.name;
  if (!name || as) {
    const base = app.model.name.replace(/\.(glb|gltf)$/i, '');
    name = await promptDialog(as ? 'Save project as' : 'Save project', name || `${base} project`, { label: 'Project name', ok: 'Save' });
    if (!name) return;
    name = name.replace(/\.animproj\.json$/i, '');
  }
  const data = projectData();
  try {
    data.thumb = hooks.thumbnail(192); // shown on the start screen
  } catch {}
  try {
    if (!(await api.ping())) throw new Error('server not running');
    const r = await api.saveProject(`${name}.animproj.json`, data);
    app.project.name = name;
    app.project.dirty = false;
    app.project.savedAt = Date.now();
    app.emit('project');
    api.autosaveDelete(app.model.name).catch(() => {});
    toast(`Project saved · ${r.path}`, 'ok');
  } catch (e) {
    // Fallback: download the file.
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const { downloadBlob } = await import('../ui/dom.js');
    downloadBlob(blob, `${name}.animproj.json`);
    app.project.name = name;
    app.project.dirty = false;
    app.emit('project');
    toast('Server unavailable — project downloaded instead', 'err');
  }
}

export async function openProjectByName(name) {
  const json = await api.loadProject(name);
  await openProjectJson(json, name.replace(/\.animproj\.json$/i, ''));
}

export async function openProjectJson(json, name = null) {
  if (app.model && app.model.name === json.model) {
    if (!(await confirmDiscard('load this project'))) return;
    applyProject(json);
  } else {
    const models = await api.models().catch(() => []);
    const m = models.find((x) => x.name === json.model);
    if (!m) return toast(`Open the model "${json.model}" first, then load the project again`, 'err');
    if (!(await openModel(m.url, m.name, { project: json }))) return;
  }
  app.project.name = name;
  app.emit('project');
  toast(`Project "${name || json.model}" loaded`, 'ok');
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------
let lastAuto = 0;
export async function autosaveNow() {
  if (!app.model || !app.project.dirty || !api.online) return;
  try {
    await api.autosavePut(app.model.name, { ...projectData(), autosave: true, projectName: app.project.name });
    lastAuto = Date.now();
    app.setStatus(`Autosaved ${new Date().toLocaleTimeString()}`);
  } catch {}
}

export function startAutosave() {
  setInterval(() => {
    if (Date.now() - lastAuto > app.settings.autosaveSec * 1000) autosaveNow();
  }, 5000);
  window.addEventListener('beforeunload', (e) => {
    if (app.project.dirty) {
      autosaveNow();
      e.preventDefault();
    }
  });
}

async function checkAutosave() {
  try {
    const data = await api.autosaveGet(app.model.name);
    if (!data || data.none || data.model !== app.model.name) return;
    const edits = data.clips.filter((c) => c.data).length;
    if (!edits && !(data.poses || []).length) return;
    toast(`Unsaved work from ${new Date(data.saved).toLocaleString()} found (${edits} edited clips)`, '', {
      ms: 15000,
      action: {
        label: 'Restore',
        run: () => {
          applyProject(data);
          app.project.name = data.projectName || null;
          app.project.dirty = true;
          app.emit('project');
          toast('Autosave restored', 'ok');
        },
      },
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Rigged models
// ---------------------------------------------------------------------------
export const riggedName = (name) => `${name.replace(/\.(glb|gltf)$/i, '').replace(/_rigged$/i, '')}_rigged.glb`;

/**
 * Write the current character (mesh + skeleton + sockets, no clips) to AnimStudio/models and
 * switch the session to that file, so the rig survives a reload and projects can find it.
 * Clips become project data (original clips of the old file would otherwise be lost).
 */
export async function saveRiggedModel({ quiet = false, file = null } = {}) {
  const model = app.model;
  if (!model) return null;
  file ||= riggedName(model.name);
  const glb = await exportGLB(model, [], { includeMesh: true, onlyVisible: false, fillRest: false });
  hooks.refreshPose();
  const r = await api.saveModel(file, new Blob([glb], { type: 'model/gltf-binary' }));
  if (model.name !== file) {
    model.name = file;
    model.url = r.url;
    app.clips = app.clips.map((c) => {
      if (!c.meta?.original) return c;
      const d = cloneClip(c);
      d.meta = { ...c.meta, original: false, source: 'derived', note: `${c.meta.note || 'from ' + c.meta.originalName}`.trim() };
      return d;
    });
    app.originals = new Map();
    app.markDirty();
    app.emit('clips');
    app.emit('project');
  }
  if (!quiet) toast(`Rigged model saved · ${r.path}`, 'ok');
  return { file, path: r.path };
}

/** Add weapon sockets to the open character and save the rigged model. Returns names added. */
export async function addWeaponSockets() {
  const model = app.model;
  if (!model) return [];
  const added = addSockets(model);
  if (!added.length) return [];
  const rebuilt = buildModel(model.gltf, model.name, model.url);
  // Keep the display state of mesh parts (materials can be swapped for the weight view).
  rebuilt.parts.forEach((p) => {
    const old = model.parts.find((o) => o.mesh === p.mesh);
    if (old) Object.assign(p, { material: old.material, name: old.name, hidden: old.hidden });
  });
  app.replaceModel(rebuilt);
  await saveRiggedModel({ quiet: true });
  toast(`Weapon sockets added: ${added.join(', ')} · rigged model saved`, 'ok');
  return added;
}
