#!/usr/bin/env node
// AnimStudio MCP server (stdio, no dependencies).
// Lets an AI assistant (Claude Code, Claude Desktop, any MCP client) drive the open AnimStudio
// app live: load characters, generate brand-new motion, key poses, adjust, use the move library,
// look at the viewport, export. Requires AnimStudio running (start.bat) with its tab open.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_FILE = path.join(HERE, '..', '.port');
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
    'Style sliders (all optional): speed (1 = same, 2 = twice as fast), intensity (whole-body energy, 1 = same), arms (arm swing scale), legs (stride scale), bounce (hips up/down scale), lean (deg, + forward), crouch (0..1, feet stay planted), armsOut (deg), headLevel (0..1: keep the eyes level, cancels head nod/roll from the body lean — use ~0.8 for big-headed characters), headNod (deg, + down), headTurn (deg, + character left), smooth (frames), life (deg of organic wobble), mirror (bool), loop (bool).',
};

const TOOLS = [
  { name: 'status', description: 'What is open in AnimStudio: model, current clip, frame, skeleton state, library size. Call this first.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_models', description: 'Characters that can be loaded.', inputSchema: { type: 'object', properties: {} } },
  { name: 'load_model', description: 'Open a character in the viewport (unsaved work is autosaved first).', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'build_skeleton', description: 'Give the current model a humanoid skeleton automatically (auto-fit markers + automatic skin weights). Needed before animating models without a recognised skeleton.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_rig', description: 'Controllable bones of the current character and the pose conventions used by key_pose.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_clips', description: 'Clips (animations) of the current character.', inputSchema: { type: 'object', properties: {} } },
  { name: 'select_clip', description: 'Select a clip and play it in the viewport.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, play: { type: 'boolean' } }, required: ['name'] } },
  { name: 'play', description: 'Play or pause, optionally a given clip and playback speed.', inputSchema: { type: 'object', properties: { play: { type: 'boolean' }, clip: { type: 'string' }, speed: { type: 'number' } } } },
  { name: 'set_time', description: 'Pause and jump to a frame (30 fps by default) or seconds.', inputSchema: { type: 'object', properties: { frame: { type: 'number' }, seconds: { type: 'number' } } } },
  {
    name: 'list_motion_types',
    description: 'Procedural motion types for generate_motion and their default parameters (walk, run, jog, sprint, sneak, march, limp, idle).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_motion',
    description:
      'Create a BRAND-NEW looping motion from scratch on the current character (no reference clips) and play it live. Use for "make me a new run/walk/sneak/idle". params override the preset: cycle (s per cycle), stride (deg hip swing), kneeLift (deg), kneeContact (deg), footRoll, armSwing, elbow (deg bend), bounce/sway/crouch (fraction of leg length), hipTwist, chestCounter, lean (deg), headBob, armOut, speed, limp (0..1), breathe (idle).',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['walk', 'run', 'jog', 'sprint', 'sneak', 'march', 'limp', 'idle'] }, params: { type: 'object' }, name: { type: 'string' }, cycles: { type: 'number' } }, required: ['type'] },
  },
  {
    name: 'regenerate_motion',
    description: 'Rebuild a clip made by generate_motion with changed parameters (e.g. more knee lift, faster) — replaces it live, keeps the name.',
    inputSchema: { type: 'object', properties: { clip: { type: 'string' }, params: { type: 'object' }, type: { type: 'string' } }, required: ['clip', 'params'] },
  },
  {
    name: 'adjust_motion',
    description: 'Restyle any clip with high-level sliders (works on generated, library, reference or hand-made clips). Replaces the clip unless as_new.',
    inputSchema: { type: 'object', properties: { clip: { type: 'string' }, params: styleParams, as_new: { type: 'boolean' }, name: { type: 'string' } }, required: ['params'] },
  },
  { name: 'create_clip', description: 'Create an empty clip to keyframe with key_pose (starts at the rest pose).', inputSchema: { type: 'object', properties: { name: { type: 'string' }, frames: { type: 'number' }, loop: { type: 'boolean' } } } },
  {
    name: 'key_pose',
    description:
      'Keyframe a pose (or several) on a clip using anatomical angles — the way to hand-author new motion (attacks, gestures, jumps...). Pass either frame + bones/hips, or poses: [{frame, bones, hips}, ...] for many keys at once. Smooth interpolation by default. The clip extends if a frame is past its end. Use ik to place hands/feet by position instead of angles.',
    inputSchema: {
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
  },
  { name: 'delete_clip', description: 'Delete one clip (or a list of clip names). Undoable.', inputSchema: { type: 'object', properties: { name: { type: ['string', 'array'], items: { type: 'string' } } }, required: ['name'] } },
  { name: 'rename_clip', description: 'Rename a clip.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, to: { type: 'string' } }, required: ['name', 'to'] } },
  { name: 'set_loop', description: 'Mark a clip as looping or one-shot.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, loop: { type: 'boolean' } }, required: ['name'] } },
  { name: 'delete_keys', description: 'Delete keys of a clip (optionally only at given frames and/or bones).', inputSchema: { type: 'object', properties: { clip: { type: 'string' }, frames: { type: 'array', items: { type: 'number' } }, bones: { type: 'array', items: { type: 'string', description: bone } } } } },
  {
    name: 'apply_modifier',
    description: 'Run a modifier on a clip: amplify (factor), smooth (radius), noise (amount, frequency), offset (frames), loopfix (frames), lockfeet (sides), ease (mode, strength), mirror, rootmotion (mode), resample (fps), reduce (angle), interp (mode), static. Optional bones scope ("all", "upper", "lower", "arms", "legs", group ids) and frame range.',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, params: { type: 'object' }, clip: { type: 'string' }, bones: { type: 'string' }, from_frame: { type: 'number' }, to_frame: { type: 'number' } }, required: ['op'] },
  },
  { name: 'list_moves', description: 'Browse ready moves: source "reference" (the animation packs in AnimStudio/animations, e.g. Quaternius: ~90 CC0 moves) or "library" (the user\'s own saved moves).', inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['reference', 'library'] }, category: { type: 'string' }, query: { type: 'string' } } } },
  { name: 'add_move', description: 'Add a ready move to the current character (retargeted automatically), optionally restyled. style_from picks a pack when a move exists in several (e.g. "Quaternius Pack 2"); from_library uses the user\'s own saved moves.', inputSchema: { type: 'object', properties: { move: { type: 'string' }, style_from: { type: 'string' }, from_library: { type: 'boolean' }, params: styleParams, name: { type: 'string' } }, required: ['move'] } },
  { name: 'library_save', description: "Save a clip into the user's own move library (stored on the AnimStudio standard skeleton, usable on any character).", inputSchema: { type: 'object', properties: { clip: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' } } } },
  { name: 'library_build_move', description: 'Save a pack move (blending its styles when there are several) to the user\'s own library of moves.', inputSchema: { type: 'object', properties: { move: { type: 'string' }, styles: { type: 'array', items: { type: 'string' } } }, required: ['move'] } },
  { name: 'select_bones', description: 'Highlight bones in the viewport (shows the user what you are working on).', inputSchema: { type: 'object', properties: { bones: { type: 'array', items: { type: 'string', description: bone } } } } },
  { name: 'snapshot', description: 'Image of the viewport so you can check your work. Optional view ("front", "left", "back", "top", "persp") and frame.', inputSchema: { type: 'object', properties: { view: { type: 'string' }, frame: { type: 'number' }, width: { type: 'number' } } } },
  { name: 'set_view', description: 'Point the camera: front, left, right, back, top, persp.', inputSchema: { type: 'object', properties: { view: { type: 'string' } } } },
  { name: 'export_glb', description: 'Export a GLB for the game (which: "mine" = new/edited clips, "all", "checked", "current"; content: "model" or "anim").', inputSchema: { type: 'object', properties: { name: { type: 'string' }, which: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'open_project', description: 'Open a saved AnimStudio project (loads its model, clips and props). Unsaved work is autosaved first.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'save_project', description: 'Save the AnimStudio project.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'add_sockets', description: 'Add weapon socket bones (Weapon_R / Weapon_L in the palms, Weapon_Back holster) to the current humanoid and save the rigged model to AnimStudio/models. Skeletons built by build_skeleton already have them.', inputSchema: { type: 'object', properties: {} } },
  { name: 'save_rigged_model', description: 'Save the current character (mesh + skeleton + sockets, no clips) as <name>_rigged.glb in AnimStudio/models so the rig survives reloads; the session switches to that file and clips become project data.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_props', description: 'Weapon sockets, built-in props (rifle, bazooka, pistol, grenade), prop files in AnimStudio/props, and the props attached now with their offsets.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'attach_prop',
    description: 'Show a weapon/prop on a socket in the viewport (preview only, not exported with the character). prop: built-in name or a .glb in AnimStudio/props. socket: Weapon_R (default), Weapon_L, Weapon_Back, or a bone. Replaces the prop already on that socket unless replace=false.',
    inputSchema: { type: 'object', properties: { prop: { type: 'string' }, socket: { type: 'string' }, name: { type: 'string' }, pos: { type: 'array', items: { type: 'number' }, description: 'offset metres [x,y,z] in socket frame' }, rot: { type: 'array', items: { type: 'number' }, description: 'rotation degrees [x,y,z]' }, scale: { type: 'number' }, replace: { type: 'boolean' } }, required: ['prop'] },
  },
  { name: 'update_prop', description: 'Change an attached prop: socket, pos, rot, scale, visible, support ([x,y,z] support-hand grip in prop-local units, null = default; use a closer grip for short-armed characters).', inputSchema: { type: 'object', properties: { name: { type: 'string' }, socket: { type: 'string' }, pos: { type: 'array', items: { type: 'number' } }, rot: { type: 'array', items: { type: 'number' } }, scale: { type: 'number' }, visible: { type: 'boolean' }, support: { type: ['array', 'null'], items: { type: 'number' } } }, required: ['name'] } },
  {
    name: 'key_weapon_pose',
    description:
      'Weapon-driven posing (best way to animate guns): for each pose, place the held weapon and IK the main hand onto it and the support hand onto its front grip, then key both arms. poses: [{frame, grip:[left,up,forward] metres from the chest, aim:[yaw deg (+ = character left), pitch deg (+ = up)], roll deg, elbow, supportElbow}]. Typical: hip/low ready grip [-0.12,-0.3,0.2] aim [0,-25]; shoulder aim grip [-0.08,0,0.15] aim [0,0]; bazooka on shoulder grip [-0.1,0.05,0.05]. Key the body (spine, legs, hips) first with key_pose; set support=false for one-handed weapons. Hands mode ({main, support} palm positions, each on its own side of the body) gives natural elbow-bent holds without arms crossing.',
    inputSchema: { type: 'object', properties: { clip: { type: 'string' }, prop: { type: 'string' }, support: { type: 'boolean' }, elbow: { type: 'string', enum: ['down', 'out', 'back'] }, support_elbow: { type: 'string', enum: ['down', 'out', 'back'] }, layer: { type: 'string' }, poses: { type: 'array', items: { type: 'object', properties: { frame: { type: 'number' }, grip: { type: 'array', items: { type: 'number' } }, aim: { type: 'array', items: { type: 'number' } }, main: { type: 'array', items: { type: 'number' }, description: 'hands mode: main palm [left,up,forward] from chest' }, support: { type: 'array', items: { type: 'number' }, description: 'hands mode: support palm; the weapon runs from main through support' }, roll: { type: 'number' } } } } }, required: ['poses'] },
  },
  {
    name: 'key_support_hand',
    description: 'Two-handed weapons: IK the support arm (side "L" default) onto the support grip of the attached prop at the given frames (default: every key frame of the clip) and key it. Pose the main hand/weapon first. elbow: "down" (default), "out", "back".',
    inputSchema: { type: 'object', properties: { clip: { type: 'string' }, frames: { type: 'array', items: { type: 'number' } }, prop: { type: 'string' }, side: { type: 'string', enum: ['L', 'R'] }, elbow: { type: 'string', enum: ['down', 'out', 'back'] }, layer: { type: 'string' } } },
  },
  { name: 'remove_prop', description: 'Remove an attached prop by name, or "all".', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'undo', description: 'Undo the last change.', inputSchema: { type: 'object', properties: {} } },
  { name: 'redo', description: 'Redo.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_commands', description: 'All AnimStudio commands (menus/shortcuts) usable with run_command.', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_command', description: 'Run any AnimStudio command by id (see list_commands). Commands that open dialogs wait for the user.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, args: {} }, required: ['id'] } },
];

const INSTRUCTIONS = `AnimStudio is a live character-animation editor open in the user's browser; every tool call changes what they see.
Workflow: status -> (load_model / build_skeleton if needed) -> create motion -> snapshot to check -> refine -> save/export.
- "New" motion: generate_motion (walk, run, jog, sprint, sneak, march, limp, idle) then regenerate_motion / adjust_motion to tune it.
- Hand-authored actions (attacks, gestures, jumps): create_clip + key_pose with anatomical angles (get_rig explains the conventions). Key the extremes first (anticipation, contact, follow-through, recovery), keep the first and last pose equal for loops.
- Existing moves: list_moves / add_move (animation packs or the user's saved moves), then adjust_motion.
- Use snapshot (several frames / views) to verify, and tell the user what you changed. Frames are 30 fps.
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

const LONG = new Set(['library_build_move', 'build_skeleton', 'export_glb', 'load_model', 'add_move', 'add_sockets', 'save_rigged_model']);

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'animstudio', version: '1.0.0' }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
    try {
      const result = await call(name, params.arguments || {}, LONG.has(name) ? 600000 : 120000);
      const content = [];
      if (result && typeof result.image === 'string') {
        const m = /^data:(image\/\w+);base64,(.*)$/.exec(result.image);
        if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] });
        delete result.image;
      }
      content.push({ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 1) });
      return { content };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  }
  if (id === undefined) return undefined; // notification
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

// ---- stdio JSON-RPC (newline-delimited) ----
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
      continue;
    }
    Promise.resolve()
      .then(() => handle(msg))
      .then((result) => {
        if (msg.id === undefined || result === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      })
      .catch((e) => {
        if (msg.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }) + '\n');
      });
  }
});
process.stdin.on('end', () => process.exit(0));
