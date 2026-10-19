#!/usr/bin/env node
// AnimStudio MCP server (stdio, no dependencies).
// Lets an AI assistant (Claude Code, Claude Desktop, any MCP client) drive the open AnimStudio
// app live: load characters, generate brand-new motion, key poses, adjust, use the move library,
// look at the viewport, export. Requires AnimStudio running (start.bat) with its tab open.
//
// Speaks both MCP eras: the handshake versions (initialize, up to 2025-11-25) and the per-request
// one (2026-07-28: server/discover, protocol version in every request's _meta).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_FILE = path.join(HERE, '..', '.port');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
const SERVER_INFO = { name: 'animstudio', title: 'AnimStudio', version: VERSION };
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN_VERSIONS = ['2026-07-28'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

// Find the AnimStudio server: env var, then the .port file, then scan 5173-5183 — preferring the
// one that has a browser tab connected.
let cachedBase = null;
async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/bridge/status`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.connected === 'number' ? j.connected : null;
  } catch {
    return null;
  }
}
async function base() {
  if (process.env.ANIMSTUDIO_PORT) return `http://127.0.0.1:${process.env.ANIMSTUDIO_PORT}`;
  if (cachedBase && (await probe(cachedBase.port)) > 0) return cachedBase.url;
  const ports = [];
  try {
    ports.push(+fs.readFileSync(PORT_FILE, 'utf8').trim());
  } catch {}
  for (let p = 5173; p <= 5183; p++) if (!ports.includes(p)) ports.push(p);
  let fallback = null;
  for (const port of ports) {
    const c = await probe(port);
    if (c === null) continue;
    if (c > 0) {
      cachedBase = { port, url: `http://127.0.0.1:${port}` };
      return cachedBase.url;
    }
    fallback ||= port;
  }
  if (fallback) return `http://127.0.0.1:${fallback}`;
  throw new Error('AnimStudio is not running. Start it (start.bat, or npm start) and keep its browser tab open.');
}

const bone = 'Anatomical bone id from get_rig (e.g. "thigh.L", "calf.R", "upperarm.L", "forearm.R", "hand.L", "foot.R", "spine.0", "chest", "neck.0", "head", "hips", "clavicle.L"). Names like "left thigh" also work.';
const poseObj = {
  type: 'object',
  description:
    'Map of bone id -> {swing, spread, twist} in degrees relative to the rest pose. swing+ = bone tip forward (feet/toes: up); knee bend = NEGATIVE calf swing; elbow bend = POSITIVE forearm swing; spread+ = away from body midline (spine/head: toward character left); twist+ = roll around the bone.',
  additionalProperties: { type: 'object', properties: { swing: { type: 'number' }, spread: { type: 'number' }, twist: { type: 'number' } } },
};
const hipsObj = { type: 'object', description: 'Hips: {move:[left,up,forward] metres, swing, spread, twist}', properties: { move: { type: 'array', items: { type: 'number' } }, swing: { type: 'number' }, spread: { type: 'number' }, twist: { type: 'number' } } };
const ikObj = { type: 'object', description: 'IK targets solved after the angles: {"hand.R": [left, up, forward] metres from the chest, "foot.L": [left, up, forward] metres from the root/ground}. Elbows point down by default, knees forward. Easiest way to place hands and feet.', additionalProperties: { type: 'array', items: { type: 'number' } } };
const polesObj = { type: 'object', description: 'Elbow direction per hand: {"hand.R": "down"|"out"|"back"}', additionalProperties: { type: 'string' } };
const styleParams = {
  type: 'object',
  description:
    'Style sliders (all optional): speed (1 = same, 2 = twice as fast), intensity (whole-body energy, 1 = same), arms (arm swing scale), legs (stride scale), bounce (hips up/down scale), lean (deg, + forward), crouch (0..1, feet stay planted), armsOut (deg), headLevel (0..1: keep the eyes level, cancels head nod/roll from the body lean — use ~0.8 for big-headed characters), headNod (deg, + down), headTurn (deg, + character left), smooth (frames), life (deg of organic wobble), mirror (bool), loop (bool), plantFeet (bool: pin the feet while they stand so they don\'t slide).',
};
const none = { type: 'object', additionalProperties: false };

// Behaviour hints for clients (MCP tool annotations): read-only tools only look; the others
// change the open project (every change can be undone with undo). AnimStudio is local, so none of
// them reach the outside world.
const READ = { readOnlyHint: true, openWorldHint: false };
const VIEW = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }; // camera, time, selection
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }; // creates something new
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }; // changes or replaces (undoable)
const tool = (name, title, description, inputSchema, annotations) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } });

const TOOLS = [
  tool('status', 'AnimStudio status', 'What is open in AnimStudio: model, current clip, frame, skeleton state, library size. Call this first.', none, READ),
  tool('list_models', 'List characters', 'Characters that can be loaded.', none, READ),
  tool('load_model', 'Open a character', 'Open a character in the viewport (unsaved work is autosaved first).', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, EDIT),
  tool('build_skeleton', 'Build a skeleton', 'Give the current model a humanoid skeleton automatically (auto-fit markers + automatic skin weights). Needed before animating models without a recognised skeleton.', none, EDIT),
  tool('get_rig', 'Skeleton and pose conventions', 'Controllable bones of the current character and the pose conventions used by key_pose.', none, READ),
  tool('list_clips', 'List clips', 'Clips (animations) of the current character.', none, READ),
  tool('select_clip', 'Select a clip', 'Select a clip and play it in the viewport.', { type: 'object', properties: { name: { type: 'string' }, play: { type: 'boolean' } }, required: ['name'] }, VIEW),
  tool('play', 'Play / pause', 'Play or pause, optionally a given clip and playback speed.', { type: 'object', properties: { play: { type: 'boolean' }, clip: { type: 'string' }, speed: { type: 'number' } } }, VIEW),
  tool('set_time', 'Go to a frame', 'Pause and jump to a frame (30 fps by default) or seconds.', { type: 'object', properties: { frame: { type: 'number' }, seconds: { type: 'number' } } }, VIEW),
  tool('list_motion_types', 'Motion types', 'Procedural motion types for generate_motion and their default parameters (walk, run, jog, sprint, sneak, march, limp, idle).', none, READ),
  tool(
    'generate_motion',
    'Generate new motion',
    'Create a BRAND-NEW looping motion from scratch on the current character (no reference clips) and play it live. Use for "make me a new run/walk/sneak/idle". params override the preset: cycle (s per cycle), stride (deg hip swing), kneeLift (deg), kneeContact (deg), footRoll, armSwing, elbow (deg bend), bounce/sway/crouch (fraction of leg length), hipTwist, chestCounter, lean (deg), headBob, armOut, speed, limp (0..1), breathe (idle), plant (default true: the feet are pinned while they stand; false keeps sparse keys for hand editing).',
    { type: 'object', properties: { type: { type: 'string', enum: ['walk', 'run', 'jog', 'sprint', 'sneak', 'march', 'limp', 'idle'] }, params: { type: 'object' }, name: { type: 'string' }, cycles: { type: 'number' } }, required: ['type'] },
    ADD
  ),
  tool('regenerate_motion', 'Regenerate motion', 'Rebuild a clip made by generate_motion with changed parameters (e.g. more knee lift, faster) — replaces it live, keeps the name.', { type: 'object', properties: { clip: { type: 'string' }, params: { type: 'object' }, type: { type: 'string' } }, required: ['clip', 'params'] }, EDIT),
  tool('adjust_motion', 'Adjust motion (sliders)', 'Restyle any clip with high-level sliders (works on generated, library, reference or hand-made clips). Replaces the clip unless as_new.', { type: 'object', properties: { clip: { type: 'string' }, params: styleParams, as_new: { type: 'boolean' }, name: { type: 'string' } }, required: ['params'] }, EDIT),
  tool('create_clip', 'New empty clip', 'Create an empty clip to keyframe with key_pose (starts at the rest pose).', { type: 'object', properties: { name: { type: 'string' }, frames: { type: 'number' }, loop: { type: 'boolean' } } }, ADD),
  tool(
    'key_pose',
    'Key a pose',
    'Keyframe a pose (or several) on a clip using anatomical angles — the way to hand-author new motion (attacks, gestures, jumps...). Pass either frame + bones/hips, or poses: [{frame, bones, hips}, ...] for many keys at once. Smooth interpolation by default. The clip extends if a frame is past its end. Use ik to place hands/feet by position instead of angles.',
    {
      type: 'object',
      properties: {
        clip: { type: 'string', description: 'Clip name (default: current clip)' },
        frame: { type: 'number' },
        bones: poseObj,
        hips: hipsObj,
        poses: { type: 'array', items: { type: 'object', properties: { frame: { type: 'number' }, bones: poseObj, hips: hipsObj, ik: ikObj, poles: polesObj } } },
        ik: ikObj,
        poles: polesObj,
        relative: { type: 'boolean', description: 'Add the angles on top of the current pose instead of the rest pose' },
        interp: { type: 'string', enum: ['smooth', 'linear', 'ease', 'step'] },
        layer: { type: 'string', description: 'Layer name to key on (default: active layer)' },
      },
    },
    EDIT
  ),
  tool('delete_clip', 'Delete clips', 'Delete one clip (or a list of clip names). Undoable.', { type: 'object', properties: { name: { type: ['string', 'array'], items: { type: 'string' } } }, required: ['name'] }, EDIT),
  tool('rename_clip', 'Rename a clip', 'Rename a clip.', { type: 'object', properties: { name: { type: 'string' }, to: { type: 'string' } }, required: ['name', 'to'] }, EDIT),
  tool('set_loop', 'Loop on/off', 'Mark a clip as looping or one-shot.', { type: 'object', properties: { name: { type: 'string' }, loop: { type: 'boolean' } }, required: ['name'] }, { ...EDIT, idempotentHint: true }),
  tool('delete_keys', 'Delete keys', 'Delete keys of a clip (optionally only at given frames and/or bones).', { type: 'object', properties: { clip: { type: 'string' }, frames: { type: 'array', items: { type: 'number' } }, bones: { type: 'array', items: { type: 'string', description: bone } } } }, EDIT),
  tool(
    'apply_modifier',
    'Apply a modifier',
    'Run a modifier on a clip: amplify (factor), smooth (radius), noise (amount, frequency), offset (frames), loopfix (frames), findloop (min, max seconds, inPlace: trim a long take to its best seamless loop), ease (mode, strength), footplant (sides, blend, ground: pin the feet while they stand, fixing foot sliding and sinking), footsteps (naming "side"|"one": an event where each foot lands), lockfeet (sides), mirror, rootmotion (mode "inplace"|"drift"|"root" = travel onto the root bone, turn), resample (fps), reduce (angle), interp (mode), static. Optional bones scope ("all", "upper", "lower", "arms", "legs", group ids) and frame range. Check the result with analyze_clip.',
    { type: 'object', properties: { op: { type: 'string' }, params: { type: 'object' }, clip: { type: 'string' }, bones: { type: 'string' }, from_frame: { type: 'number' }, to_frame: { type: 'number' } }, required: ['op'] },
    EDIT
  ),
  tool(
    'analyze_clip',
    'Analyse a clip',
    'Measure a clip: loop seam, what moves, key pose frames, and the feet: steps (frames each foot is down), sliding (cm), sinking into the floor, floating, the speed to move the character at in a game, events — with advice on which tool fixes what. Use it to check your work alongside snapshot.',
    { type: 'object', properties: { clip: { type: 'string', description: 'Clip name (default: current clip)' } } },
    READ
  ),
  tool(
    'sequence_clips',
    'Chain clips (transitions)',
    'Make a new clip that plays clips one after another the way a game blends them, e.g. Idle → Walk → Run: steps [{clip, repeat (times it plays), blend (crossfade frames into the next)}]. Moves that travel carry on from where they got to.',
    { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { clip: { type: 'string' }, repeat: { type: 'number' }, blend: { type: 'number' } }, required: ['clip'] } }, name: { type: 'string' } }, required: ['steps'] },
    ADD
  ),
  tool('list_moves', 'Browse moves', 'Browse ready moves: source "reference" (the animation packs in AnimStudio/animations, e.g. Quaternius: ~90 CC0 moves) or "library" (the user\'s own saved moves).', { type: 'object', properties: { source: { type: 'string', enum: ['reference', 'library'] }, category: { type: 'string' }, query: { type: 'string' } } }, READ),
  tool('add_move', 'Add a move', 'Add a ready move to the current character (retargeted automatically, feet planted unless params.plantFeet is false), optionally restyled. style_from picks a pack when a move exists in several (e.g. "Quaternius Pack 2"); from_library uses the user\'s own saved moves. A "My edits" layer is added on top for hand edits.', { type: 'object', properties: { move: { type: 'string' }, style_from: { type: 'string' }, from_library: { type: 'boolean' }, params: styleParams, name: { type: 'string' } }, required: ['move'] }, ADD),
  tool('library_save', 'Save to my moves', "Save a clip into the user's own move library (stored on the AnimStudio standard skeleton, usable on any character).", { type: 'object', properties: { clip: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' } } }, ADD),
  tool('library_build_move', 'Build a library move', 'Save a pack move (blending its styles when there are several) to the user\'s own library of moves.', { type: 'object', properties: { move: { type: 'string' }, styles: { type: 'array', items: { type: 'string' } } }, required: ['move'] }, ADD),
  tool('select_bones', 'Highlight bones', 'Highlight bones in the viewport (shows the user what you are working on).', { type: 'object', properties: { bones: { type: 'array', items: { type: 'string', description: bone } } } }, VIEW),
  tool('snapshot', 'Viewport snapshot', 'Image of the viewport so you can check your work. Optional view ("front", "left", "back", "top", "persp") and frame.', { type: 'object', properties: { view: { type: 'string' }, frame: { type: 'number' }, width: { type: 'number' } } }, READ),
  tool('set_view', 'Point the camera', 'Point the camera: front, left, right, back, top, persp.', { type: 'object', properties: { view: { type: 'string' } } }, VIEW),
  tool(
    'export_glb',
    'Export GLB',
    'Export a GLB for the game (which: "mine" = new/edited clips, "all", "checked", "current"; content: "model" or "anim"). engine "godot" names looping clips "<name>-loop" so Godot loops them (loop_names); root_motion: "keep", "inplace" (no travel) or "root" (travel on the root bone, for root motion in the engine). Also writes <name>.events.json (loop flags, events, each move\'s speed) unless sidecar is false.',
    { type: 'object', properties: { name: { type: 'string' }, which: { type: 'string' }, content: { type: 'string' }, engine: { type: 'string', enum: ['any', 'godot', 'unity', 'unreal', 'blender'] }, root_motion: { type: 'string', enum: ['keep', 'inplace', 'root'] }, loop_names: { type: 'boolean' }, fps: { type: 'number' }, reduce: { type: 'number', description: 'key reduction tolerance in degrees (0 = exact)' }, sidecar: { type: 'boolean' } } },
    { ...ADD, idempotentHint: true }
  ),
  tool('open_project', 'Open a project', 'Open a saved AnimStudio project (loads its model, clips and props). Unsaved work is autosaved first.', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, EDIT),
  tool('save_project', 'Save the project', 'Save the AnimStudio project.', { type: 'object', properties: { name: { type: 'string' } } }, { ...ADD, idempotentHint: true }),
  tool('add_sockets', 'Add weapon sockets', 'Add weapon socket bones (Weapon_R / Weapon_L in the palms, Weapon_Back holster) to the current humanoid and save the rigged model to AnimStudio/models. Skeletons built by build_skeleton already have them.', none, ADD),
  tool('save_rigged_model', 'Save the rigged model', 'Save the current character (mesh + skeleton + sockets, no clips) as <name>_rigged.glb in AnimStudio/models so the rig survives reloads; the session switches to that file and clips become project data.', none, { ...ADD, idempotentHint: true }),
  tool('list_props', 'List props', 'Weapon sockets, built-in props (rifle, bazooka, pistol, grenade), prop files in AnimStudio/props, and the props attached now with their offsets.', none, READ),
  tool(
    'attach_prop',
    'Attach a prop',
    'Show a weapon/prop on a socket in the viewport (preview only, not exported with the character). prop: built-in name or a .glb in AnimStudio/props. socket: Weapon_R (default), Weapon_L, Weapon_Back, or a bone. Replaces the prop already on that socket unless replace=false.',
    { type: 'object', properties: { prop: { type: 'string' }, socket: { type: 'string' }, name: { type: 'string' }, pos: { type: 'array', items: { type: 'number' }, description: 'offset metres [x,y,z] in socket frame' }, rot: { type: 'array', items: { type: 'number' }, description: 'rotation degrees [x,y,z]' }, scale: { type: 'number' }, replace: { type: 'boolean' } }, required: ['prop'] },
    ADD
  ),
  tool('update_prop', 'Change a prop', 'Change an attached prop: socket, pos, rot, scale, visible, support ([x,y,z] support-hand grip in prop-local units, null = default; use a closer grip for short-armed characters).', { type: 'object', properties: { name: { type: 'string' }, socket: { type: 'string' }, pos: { type: 'array', items: { type: 'number' } }, rot: { type: 'array', items: { type: 'number' } }, scale: { type: 'number' }, visible: { type: 'boolean' }, support: { type: ['array', 'null'], items: { type: 'number' } } }, required: ['name'] }, { ...EDIT, idempotentHint: true }),
  tool(
    'key_weapon_pose',
    'Key a weapon pose',
    'Weapon-driven posing (best way to animate guns): for each pose, place the held weapon and IK the main hand onto it and the support hand onto its front grip, then key both arms. poses: [{frame, grip:[left,up,forward] metres from the chest, aim:[yaw deg (+ = character left), pitch deg (+ = up)], roll deg, elbow, supportElbow}]. Typical: hip/low ready grip [-0.12,-0.3,0.2] aim [0,-25]; shoulder aim grip [-0.08,0,0.15] aim [0,0]; bazooka on shoulder grip [-0.1,0.05,0.05]. Key the body (spine, legs, hips) first with key_pose; set support=false for one-handed weapons. Hands mode ({main, support} palm positions, each on its own side of the body) gives natural elbow-bent holds without arms crossing.',
    { type: 'object', properties: { clip: { type: 'string' }, prop: { type: 'string' }, support: { type: 'boolean' }, elbow: { type: 'string', enum: ['down', 'out', 'back'] }, support_elbow: { type: 'string', enum: ['down', 'out', 'back'] }, layer: { type: 'string' }, poses: { type: 'array', items: { type: 'object', properties: { frame: { type: 'number' }, grip: { type: 'array', items: { type: 'number' } }, aim: { type: 'array', items: { type: 'number' } }, main: { type: 'array', items: { type: 'number' }, description: 'hands mode: main palm [left,up,forward] from chest' }, support: { type: 'array', items: { type: 'number' }, description: 'hands mode: support palm; the weapon runs from main through support' }, roll: { type: 'number' } } } } }, required: ['poses'] },
    EDIT
  ),
  tool('key_support_hand', 'Key the support hand', 'Two-handed weapons: IK the support arm (side "L" default) onto the support grip of the attached prop at the given frames (default: every key frame of the clip) and key it. Pose the main hand/weapon first. elbow: "down" (default), "out", "back".', { type: 'object', properties: { clip: { type: 'string' }, frames: { type: 'array', items: { type: 'number' } }, prop: { type: 'string' }, side: { type: 'string', enum: ['L', 'R'] }, elbow: { type: 'string', enum: ['down', 'out', 'back'] }, layer: { type: 'string' } } }, EDIT),
  tool('remove_prop', 'Remove props', 'Remove an attached prop by name, or "all".', { type: 'object', properties: { name: { type: 'string' } } }, EDIT),
  tool('undo', 'Undo', 'Undo the last change.', none, EDIT),
  tool('redo', 'Redo', 'Redo.', none, EDIT),
  tool('list_commands', 'List app commands', 'All AnimStudio commands (menus/shortcuts) usable with run_command.', none, READ),
  tool('run_command', 'Run an app command', 'Run any AnimStudio command by id (see list_commands). Commands that open dialogs wait for the user.', { type: 'object', properties: { id: { type: 'string' }, args: {} }, required: ['id'] }, EDIT),
];

const INSTRUCTIONS = `AnimStudio is a live character-animation editor open in the user's browser; every tool call changes what they see.
Workflow: status -> (load_model / build_skeleton if needed) -> create motion -> snapshot and analyze_clip to check -> refine -> save/export.
- "New" motion: generate_motion (walk, run, jog, sprint, sneak, march, limp, idle) then regenerate_motion / adjust_motion to tune it.
- Hand-authored actions (attacks, gestures, jumps): create_clip + key_pose with anatomical angles (get_rig explains the conventions). Key the extremes first (anticipation, contact, follow-through, recovery), keep the first and last pose equal for loops.
- Existing moves: list_moves / add_move (animation packs or the user's saved moves), then adjust_motion.
- Check with snapshot (several frames / views) and analyze_clip (foot sliding, sinking, loop seam, speed); fix sliding feet with apply_modifier op "footplant", add footstep events with op "footsteps". Tell the user what you changed. Frames are 30 fps.
- Transitions: sequence_clips plays clips one after another as a game blends them (Idle -> Walk -> Run).
- For a game: export_glb (engine "godot" names looping clips so Godot loops them; root_motion "root" puts the travel on the root bone).
- Weapons: add_sockets (if list_props shows them missing) -> attach_prop (rifle, bazooka, pistol, grenade or a .glb from AnimStudio/props) -> key the body with key_pose, then the arms with key_weapon_pose (weapon placement + IK) -> snapshot. Weapon actions (aim, fire, reload) usually go on an override layer masked to the upper body so the legs keep running/idling underneath.`;

async function call(cmd, args, timeout) {
  let res;
  const url = await base();
  try {
    res = await fetch(`${url}/api/bridge/call`, { method: 'POST', body: JSON.stringify({ cmd, args, timeout }), headers: { 'Content-Type': 'application/json' } });
  } catch {
    throw new Error('AnimStudio server is not running. Start AnimStudio (start.bat, or npm start) and open it in the browser.');
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j.result;
}

const LONG = new Set(['library_build_move', 'build_skeleton', 'export_glb', 'load_model', 'add_move', 'add_sockets', 'save_rigged_model', 'open_project']);
const rpcError = (code, message, data) => Object.assign(new Error(message), { code, data });

async function callTool(params) {
  const name = params?.name;
  if (!TOOLS.some((t) => t.name === name)) throw rpcError(-32602, `Unknown tool: ${name}`);
  try {
    const result = await call(name, params.arguments || {}, LONG.has(name) ? 600000 : 120000);
    const content = [];
    if (result && typeof result.image === 'string') {
      const m = /^data:(image\/\w+);base64,(.*)$/.exec(result.image);
      if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] });
      delete result.image;
    }
    const data = result ?? { ok: true };
    content.push({ type: 'text', text: JSON.stringify(data, null, 1) });
    // Objects also come as structured content (lists stay text only, for clients that want objects).
    return data && typeof data === 'object' && !Array.isArray(data) ? { content, structuredContent: data } : { content };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const meta = params?._meta;
  // Per-request protocol (2026-07-28 and later): the version comes with every request.
  const modern = !!meta && typeof meta[META_VERSION] === 'string';
  if (modern && !MODERN_VERSIONS.includes(meta[META_VERSION])) throw rpcError(-32022, 'Unsupported protocol version', { supported: MODERN_VERSIONS, requested: meta[META_VERSION] });
  const done = (r) => (modern ? { resultType: 'complete', ...r, _meta: { ...(r._meta || {}), [META_SERVER]: SERVER_INFO } } : r);
  switch (method) {
    case 'initialize': {
      // Handshake protocol: answer with the client's version when we speak it, else our newest.
      const v = params?.protocolVersion;
      return { protocolVersion: LEGACY_VERSIONS.includes(v) ? v : LEGACY_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    }
    case 'server/discover':
      return { resultType: 'complete', supportedVersions: MODERN_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, _meta: { [META_SERVER]: SERVER_INFO } };
    case 'ping':
      return done({});
    case 'tools/list':
      return done({ tools: TOOLS });
    case 'tools/call':
      return done(await callTool(params));
  }
  if (id === undefined) return undefined; // notifications (initialized, cancelled…) need no answer
  throw rpcError(-32601, `Method not found: ${method}`);
}

// ---- stdio JSON-RPC (newline-delimited) ----
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    Promise.resolve()
      .then(() => handle(msg))
      .then((result) => {
        if (msg.id === undefined || result === undefined) return;
        send({ jsonrpc: '2.0', id: msg.id, result });
      })
      .catch((e) => {
        if (msg.id === undefined) return;
        send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message, ...(e.data ? { data: e.data } : {}) } });
      });
  }
});
process.stdin.on('end', () => process.exit(0));
