# AnimStudio: project overview

**AnimStudio is a browser-based character animation studio for game characters.** It takes your own 3D characters (`.glb`, e.g. from Meshy AI) and gives them a game skeleton when they need one. It then puts ready-made moves on them (animation packs you add, such as Mixamo or Quaternius) and lets you adjust and hand-edit those moves. The result is a game-ready GLB for Godot, Unity, Unreal or Blender. An AI (Claude, via MCP) can drive the open app live.

AnimStudio is free and open source (AGPL-3.0). It ships without characters or animations: you bring your own, and they stay on your computer.

For the full user guide, see [README.md](README.md); for what changed recently, see [CHANGELOG.md](CHANGELOG.md). In the app, **F1** opens the guide and **Ctrl+K** searches every command.

---

## Goals

1. **Animate your own characters:** Meshy and other models get a clean humanoid skeleton with good skin weights. The head and anything hanging off it stay solid.
2. **Start from good motion, then make it yours:** take moves from animation packs or Mixamo, adjust them with sliders, and hand-edit them on a separate layer.
3. **Own the result:** your saved moves live on AnimStudio's own neutral skeleton (★ My moves) and work on any character.
4. **AI-assisted:** Claude can create, adjust and check motion through 42 MCP tools.

---

## Quick start

| Step | What to do |
|---|---|
| 1 | Install **Node.js 18+** |
| 2 | Double-click **`start.bat`** (macOS/Linux: `npm install`, then `npm start`). The browser opens; keep the console window open |
| 3 | Drop your character `.glb` on the start screen (or pick it under *My characters*) |
| 3b | Start page › **＋ Add animations**: Mixamo `.fbx` downloads or `.glb` packs (see README) |
| 4 | No skeleton? **Tools › Build skeleton**. Rigged files are saved to `models/<name>_rigged.glb` |
| 5 | **✦ Moves** → pick a move → *Adjust* → **Add as new clip** → pose on *My edits* |
| 6 | **Save** (Ctrl+S) and **Export GLB** (Ctrl+E) |

---

## Main features

| Area | What it does |
|---|---|
| **Start page** | Continue (projects with thumbnails), My characters, drop zone, **Animation packs**, feature list |
| **Skeleton builder** | Fit a pink reference skeleton with sliders, fine-tune single joints, then build a 30-bone humanoid with automatic skin weights and 3 weapon sockets |
| **Edit skeleton** | Reopens a built skeleton at its current joints; move any joint and press *Update*. The skin is redone and **all clips are kept** (hip heights follow) |
| **Skin weights** | Rigid head (no stretching); everything that hangs off the head (helmet rim, hair, bandana tails) follows the head, decided along the mesh surface; separate pieces stay solid |
| **✦ Moves** | 87 moves from two CC0 Quaternius packs (any GLB in `animations/` adds more). Live preview on your character, sliders (speed, energy, arms, stride, bounce, lean, crouch, arms out, **keep head level**, head nod/turn, smoothness, life, mirror, loop) |
| **My edits layer** | Added moves get an empty additive layer on top, selected, so hand edits never damage the original motion |
| **Mixamo import** | Drop `.fbx` files (with or without skin); each becomes a clip on your character |
| **Editing** | Drag joint dots directly (hands and feet use IK), gizmos, IK, lock feet, mirror and flip, pose library, layers with masks, dope sheet, graph editor, undo/redo |
| **Modifiers** | Exaggerate, smooth, add life, overlap, ease timing, loop fix, plant feet, mirror, root motion, key reduction (live preview) |
| **Retargeting** | Moves animation between different skeletons, including Blender Z-up rigs and Mixamo |
| **Weapons & props** | Sockets `Weapon_R/L/Back`, prop preview (built-in rifle/bazooka/pistol/grenade or any GLB in `props/`) |
| **Export** | GLB with model + animations or animations only; bake/reduce; events sidecar JSON |
| **AI / MCP** | 42 tools: status, snapshot, moves, sliders, key poses, generated gaits, skeleton, export… |
| **Parked** | Motion from video (MediaPipe): the code and tests are kept, the UI is hidden |

---

## How it fits together

```
 Browser (index.html + src/)                    Node server (server.cjs, no dependencies)
 ┌──────────────────────────────┐               ┌──────────────────────────────────────┐
 │ UI: viewport, dope sheet,    │  HTTP + SSE   │ serves the app, models, packs        │
 │ graph, panels, ✦ Moves,      │◄─────────────►│ projects / autosave / exports        │
 │ skeleton builder             │               │ ★ moves (library/*.move.json)        │
 │ app/bridge.js (AI commands)  │               │ live bridge  /api/bridge/*           │
 └──────────────────────────────┘               └──────────────────▲───────────────────┘
               ▲                                                   │ HTTP
               │ uses                           ┌──────────────────┴───────────────────┐
 ┌──────────────────────────────┐               │ mcp/server.mjs  (MCP over stdio)     │
 │ src/core/  (pure engine,     │               │ ← Claude Code / Claude Desktop        │
 │ also runs in Node tests)     │               └──────────────────────────────────────┘
 └──────────────────────────────┘
```

### Folder map

```
AnimStudio/
  .mcp.json                  registers the AnimStudio MCP server for Claude Code
  start.bat, server.cjs      launcher and local server
  index.html, css/app.css    app shell and styles
  src/core/                  animation engine (no DOM)
    channel.js clip.js evaluate.js keying.js     keys, clips, layers, evaluation
    rig.js anatomy.js                            skeleton analysis, anatomical pose controls
    ik.js ops.js style.js analysis.js            IK, modifiers, sliders (keepHeadLevel), analysis
    retarget.js standard.js gait.js              retargeting, standard skeleton, gait generator
    movecatalog.js history.js project.js         move names/categories, undo, project files
    videomotion.js                               (parked) video landmarks -> clip
  src/io/                    loader (GLB/FBX), rigbuild (skeleton + skin), packs, exporter,
                             library, animsource, api, sockets, propshapes, posetrack (parked)
  src/app/                   state, commands, actions, dialogs (start page), session, AI bridge
  src/ui/                    viewport, dope sheet, graph, panels, movemaker, rigbuilder, props
  mcp/server.mjs             MCP server (42 tools)
  models/                    your characters (rigged models saved by the builder)
  animations/                animation packs (Quaternius Pack 1 & 2, CC0) + index.json
  library/                   ★ My moves (*.move.json)
  props/                     weapon / prop GLBs for the preview
  projects/                  saved projects + .autosave/
  exports/                   exported GLBs
  vendor/mediapipe/          (parked) pose tracker for motion from video
  tests/                     Node tests (npm test) + fixtures/
```

### Key design choices

- **No build step:** native ES modules plus three.js from `node_modules`; MediaPipe is vendored.
- **Copy-on-write clips:** every edit clones a clip, which makes undo/redo and live previews simple and safe.
- **One command registry:** menus, shortcuts, the palette, toolbar buttons and AI tools all run the same commands.
- **Layers for editing:** captured or pack motion stays on *Base*; your edits live on *My edits* (additive).
- **Built skeletons have fixed bone names and identity rest rotations.** That's why Edit skeleton can move joints and keep every clip.
- **Skinning by surface distance at the head:** a geodesic split between the head and the body decides what hangs off the head. It matters for one-piece Meshy meshes.
- **Standard skeleton:** saved moves don't depend on any source model.

---

## AI control (MCP)

- **Setup:** `.mcp.json` registers `mcp/server.mjs`. Start AnimStudio, keep the tab open, start Claude Code in the AnimStudio folder and approve **animstudio** (`/mcp`).
- **Main tools:**
  - `status`, `list_clips`, `snapshot` (the AI sees the viewport).
  - `list_moves` / `add_move` (animation packs or ★ moves), and `adjust_motion` (the sliders, including `headLevel`).
  - `create_clip` + `key_pose` (anatomical angles + IK targets).
  - `generate_motion` (procedural gaits), `apply_modifier`.
  - `build_skeleton`, `export_glb`, `save_project`, `run_command`.
- **Bridge for scripts:** `POST http://localhost:5173/api/bridge/call` with `{"cmd":"…","args":{…}}`.

---

## Testing

- `npm test` runs **37** tests: rig labelling, IK (incl. pole vectors), layered keying, modifiers, retargeting, gait generation on T-pose rigs, building animation packs, weapon sockets, video-capture conversion round trips, cycle averaging and keep-head-level.
- Tests that need real animation data are *skipped* until the Quaternius packs are in `animations/` (see `tests/helpers.js`); everything else uses a character rigged by AnimStudio and generated motion.
- The UI is checked with headless-browser runs (chrome-headless-shell) against a second server on another port.

---

## Status & next steps

**Working now:** everything listed above.

**Ideas for next:**
1. **Text to motion** with a local model (e.g. NVIDIA Kimodo): type "heavy overhead sword swing", get a clip.
2. **Motion from video** back on (parked): webcam/phone capture with cycle averaging.
3. **Godot export preset:** naming, loops and root motion ready for AnimationTree, then test in the game.
4. **Transition preview:** Idle → Walk → Run → Attack as the game would blend it.
5. **Weapons:** two-hand grips on the new packs' sword/pistol moves (the gun work was parked).
6. Fingers and tails in the skeleton builder.

---

## Known limits

- The skeleton builder targets upright humanoids (two arms, two legs, one head); fingers and tails aren't built.
- Very different proportions (chibi vs tall) can need small fixes: *Keep head level*, *Lean*, *Crouch* or the *My edits* layer.
- No direct FBX export; convert the GLB in Blender if needed.
- The AI only works while AnimStudio is running with its browser tab open.
