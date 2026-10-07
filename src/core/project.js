// Project files: everything needed to resume work — which model, edited/new clips, export
// selection, bone nicknames, pose library. Unmodified original clips are stored by reference.
import { serializeClip, deserializeClip } from './clip.js';

export const PROJECT_FORMAT = 'animstudio.project';
export const PROJECT_VERSION = 1;

/**
 * @param state { model, clips, originals: Map<name, clip>, excluded: Set<clipId>, nick, poses, props, settings }
 */
export function serializeProject(state) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: 'AnimStudio',
    saved: new Date().toISOString(),
    model: state.model,
    settings: state.settings || {},
    nick: state.nick || {},
    poses: (state.poses || []).map((p) => ({ ...p })),
    props: (state.props || []).map((p) => JSON.parse(JSON.stringify(p))),
    clips: state.clips.map((c) => {
      const pristine = c.meta?.original && state.originals.get(c.meta.originalName) === c;
      const checked = !state.excluded.has(c.id);
      return pristine ? { ref: c.meta.originalName, checked } : { data: serializeClip(c), checked };
    }),
  };
}

/** Returns { clips, excludedIds, nick, poses, settings, missing: string[] } */
export function deserializeProject(json, originals) {
  if (json?.format !== PROJECT_FORMAT) throw new Error('Not an AnimStudio project file');
  const clips = [];
  const excluded = new Set();
  const missing = [];
  for (const entry of json.clips || []) {
    let clip = null;
    if (entry.ref) {
      clip = originals.get(entry.ref) || null;
      if (!clip) missing.push(entry.ref);
    } else if (entry.data) clip = deserializeClip(entry.data);
    if (!clip) continue;
    clips.push(clip);
    if (entry.checked === false) excluded.add(clip.id);
  }
  return { clips, excluded, nick: json.nick || {}, poses: json.poses || [], props: json.props || [], settings: json.settings || {}, missing };
}
