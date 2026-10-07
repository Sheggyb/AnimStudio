# AnimStudio

A character animation studio that runs in your browser. Load a `.glb` character (Meshy, Blender, Mixamo…), give it a skeleton if it has none, start from ready-made moves (animation packs you add, Mixamo), make them your own, and export a game-ready GLB. See [PROJECT.md](PROJECT.md) for the overview and [CHANGELOG.md](CHANGELOG.md) for what changed recently.

Free and open source under the [AGPL-3.0](LICENSE). Your characters, animations and exported files are yours: the licence covers AnimStudio's code, not what you make with it.

It works with any glTF/GLB file:

- **Characters without animations** open with an empty "Animation 1" clip, ready to pose.
- **Models without a skeleton** (props, weapons, doors, chests) get one automatically: a *Root* bone plus one bone per separate part. You can animate the whole object or each part, and export it like any other GLB.

---

## Start

1. Install **Node.js 18 or newer** (https://nodejs.org).
2. Get AnimStudio: `git clone` this repository (or download it as a ZIP and unpack it).
3. Start it:
   - **Windows:** double-click **`start.bat`**.
   - **macOS / Linux:** run `npm install` once, then `npm start`.

   The browser opens AnimStudio by itself. Keep the console window open while you work; closing it stops AnimStudio.
4. Drop your character (`.glb` or `.fbx`) on the start screen.
5. **Add animations** (see below), then open ✦ Moves on your character.

AnimStudio comes without characters or animations: you bring your own, and they stay on your computer in these folders (none of them is part of the repository):

| Folder | What's in it |
|---|---|
| `models/` | Your characters (rigged models are saved here as `<name>_rigged.glb`), listed on the start screen |
| `animations/` | Animation packs (GLBs full of moves) for ✦ Moves, added with **＋ Add animations** |
| `library/` | ★ My moves (`*.move.json`) |
| `props/` | Weapon / prop GLBs for the preview |
| `exports/` | GLB files you export (they also show up on the start screen) |
| `projects/` | Saved projects, plus `.autosave/` |

### Add animations

On the start page, press **＋ Add animations** (or drop files on the *Animation packs* section). ✦ Moves will offer them on every character.

| Where | What to download | Add |
|---|---|---|
| [Mixamo](https://www.mixamo.com) (free Adobe account) | Thousands of mocap moves. Format **FBX**, **30 fps**, tick **In Place** for walks and runs, with or without skin | The `.fbx` files, as many at once as you like. They become a *Mixamo Pack*; later downloads are added to it |
| [Quaternius](https://quaternius.com) | *Universal Animation Library* 1 and 2: free (CC0) packs of game moves | The `.glb` files as they are |
| Anything else | Animations exported as `.glb` or `.fbx` (Blender, other packs) | Files with the same skeleton go into one pack |

Each source has its own terms: Mixamo animations can be used in your games, but don't redistribute the raw files or packs.

---

## From a new character to game animations (the short version)

1. **Open the character:** drop the `.glb` (e.g. from Meshy) on the start screen.
2. **Give it a skeleton:** Tools › Build skeleton → check the pink reference fits → **Build skeleton**. It's saved as `models/<name>_rigged.glb`; open that file from now on.
3. **Check the skin:** click **Weights**, then click the Head bone. The whole head (helmet, hair, bandana) should be red. Click the arms and legs too.
4. **Add moves:** **✦ Moves** → pick one (walk, sword attack, jump…) → **2 · Adjust** (for big-headed characters set *Keep head level* to 80–100%) → **Add as new clip**.
5. **Make it yours:** pose any frame. Your changes land on the *My edits* layer above the original motion.
6. **Something looks off?** See *Troubleshooting* below. Usually: **Rig tab › ✎ Edit skeleton** to move a joint, then **Update skeleton**. Your clips are kept.
7. **Save** (Ctrl+S) and **Export GLB** (Ctrl+E) for the game.

---

## The screen

```
┌ menus · model ·························· Commands (Ctrl+K) · Save · Export GLB ┐
│ Clips          │            3D viewport                      │ Pose │ Layers │
│ (search,       │  tools: Select/Rotate/Move/IK, Lock feet,   │ Modify│ Clip │ │
│  filters)      │  Onion, Trail, Ghost, Weights               │ Rig            │
│ Pose library   │  camera: Front/Side/Top/3-4/Frame           │                │
├────────────────┴─────────────────────────────────────────────┴────────────────┤
│ transport ▶ · frame · loop · speed · fps · Auto-key · Key · interpolation      │
│ Dope Sheet  /  Graph Editor                                                    │
└───────────────────────────────────────────────────── status bar ──────────────┘
```

Press **Ctrl+K** to search every command, **F1** for the quick guide, and **?** for all shortcuts.

---

## Animation packs: start from good moves, then make them yours

`AnimStudio/animations` holds two free packs by Quaternius: *Quaternius Pack 1.glb* and *Quaternius Pack 2.glb*, the Universal Animation Library 1 & 2 Standard, CC0 (public domain).
- That's 87 moves: idle, walk, jog, sprint, crouch, jumps, roll, punches, sword attacks and combos, block, shield, pistol, spells, hits, knockbacks, death, zombie moves, dance, sitting, swimming, farming and more.
- Any other GLB full of animations dropped into `AnimStudio/animations` shows up too (restart AnimStudio, or list it in `animations/index.json`).

The workflow:
1. Open your character and press **✦ Moves** (Ctrl+Shift+M). Search or pick a category, and click a move: it plays on your character right away.
2. **2 · Adjust**: speed, energy, arm swing, lean, crouch, arms in/out, keep head level, head, smoothness, mirror.
3. **Add as new clip**. The move becomes the clip's *Base* layer, and an empty **My edits** layer on top is selected.
4. Pose the character at any frame (drag the dots, the gizmos or IK). Your changes go on *My edits*, so the original motion stays intact underneath. Mute the layer to compare, or lower its weight in the Layers tab.
5. **★ Save to my moves** keeps a move (with your slider settings) for reuse on other characters.

## Mixamo animations (thousands of free mocap moves)

[Mixamo](https://www.mixamo.com) (free Adobe account) has a big library of motion-captured walks, runs, attacks, dances and emotes, free to use in games. There are two ways to use them:
- **As moves for every character:** start page › **＋ Add animations** (see *Add animations* above). They go into a pack that ✦ Moves offers on any character.
- **Straight onto one character,** as described below.

1. On Mixamo, open an animation and adjust it with its sliders. Tick **In Place** for walks and runs.
2. Press **Download** with these settings:
   - Format **FBX Binary (.fbx)**.
   - Skin **Without Skin** (smaller; With Skin works too).
   - **30** frames per second.
3. Open your character in AnimStudio and **drop the .fbx files** onto the window. Several at once is fine, or use File › Import (Ctrl+I).

Each file becomes a clip on your character, named after the file. Loops are detected automatically. No need to upload your character to Mixamo: AnimStudio matches the Mixamo skeleton to yours. Polish the clips with the Move Maker sliders or modifiers like any other clip.

**A whole folder at once:** `node tools/build-mixamo-pack.mjs <folder> [pack name]` turns every `.fbx`/`.glb` in a folder into `animations/<pack name>.glb` (default: the `mixamo/` folder into *Mixamo Pack*). It does the same as ＋ Add animations, for hundreds of files.

Mixamo animations may be used in your own games, but don't share the raw files or the pack.

## 1. Study an animation

- **Play** a clip with Space. Hover a joint to see its name. The skeleton is labeled automatically (Hips, Spine, Chest, L Upper arm, R Thigh, …) and colored by body part.
- **Graph Editor** (bottom tab): click a joint to see its rotation curves. Steep sections are fast motion; flat sections are holds.
- **Onion skin** (O) shows ghosts of the frames before and after. **Trail** (T) draws the selected joint's path through the clip.
- **Clip tab:**
  - which body parts do the work (motion share);
  - whether the clip loops cleanly;
  - the peak speed;
  - the range of motion of the selected joint.
- **Show key poses** marks the moments where the body is momentarily still: the extremes and contacts an animator would key first.
- **Weights** shows which part of the mesh each bone moves.

## 2. Change an animation without destroying it

**Layers** (Layers tab or the Layers menu):

- **Additive layer:** pose bones while it is active, and your change is *added on top* of the original motion.
  - One key changes the whole clip (e.g. hold the arms higher during the entire run).
  - Several keys make a change that varies over time.
- **Override layer:** replaces the motion of masked body parts.
- Every layer has a **weight** slider, **mute**, and a **body-part mask**. **Merge all → Base** bakes the layers into one.

**Modifiers** (Modify tab / Tools menu) preview *live* and can be limited to the selected bones and/or a time range. Shift+drag on the timeline ruler sets the range.

| Modifier | Use it for |
|---|---|
| Exaggerate / calm down | Punchier attacks, calmer idles (scales the motion around the average pose) |
| Smooth | Remove jitter |
| Add life (noise) | Breathing, nervousness, hand-held feel (loops seamlessly on looping clips) |
| Overlap / delay | Follow-through: arms or head lag behind the body |
| Ease timing | Slow-in / slow-out without changing the length |
| Make seamless loop | Fix a pop at the loop point |
| Plant feet (IK) | Stop foot sliding after you changed the body |
| Mirror left ↔ right | Left-handed versions of attacks |
| Root motion | Keep the character in place |
| Simplify to N fps / Reduce keys | Turn every-frame captured data into a few editable keys |
| Set interpolation / Clean static channels | Key housekeeping |

**Timing:** Speed / length, Reverse, Trim to range, Cut range, and Insert hold (a dramatic pause).

Everything can be undone (Ctrl+Z). **Ghost** (G) overlays the original clip so you can compare.

## 3. Create new animations

1. Choose a starting pose. For example, play an idle and pause, or apply a pose from the pose library.
2. Press **Shift+N** (or **+ New** in the Clips panel) to create a new clip from that pose, with a length and an optional loop.
3. Move the playhead, pose the body, and keys are recorded automatically (**Auto-key**, shown red when on). Press **K** to key manually.
   - **Drag the dots directly** (any tool): a **hand or foot** dot moves the whole arm or leg (IK, the elbow or knee keeps its bend); an **elbow, knee, shoulder or head** dot swings the bone above it towards the mouse; the **hips** dot moves the body. Releasing keys the pose. Dragging empty space still turns the camera.
   - **Rotate** (E) / **Move** (W) gizmos for exact control; X switches between local and world space.
   - **IK** (I): click a hand or foot and drag the pink target. The elbow or knee follows.
   - **Lock feet**: move or rotate the hips and spine while the feet stay planted, which is great for crouches and lunges.
   - **Mirror → other side** (M), **Flip whole pose** (Shift+M), and **Paste mirrored** (Ctrl+Shift+V).
   - **Pose library**: save poses (with thumbnails) and apply them to any clip, mirrored or blended 50%.
4. **Dope sheet:** box-select keys, drag to retime, Alt+drag to scale timing, Ctrl+C/Ctrl+V copy and paste, and right-click for interpolation (Smooth / Linear / Ease / Step).
5. **Graph editor:** drag keys up and down to change values, or left and right to retime.

## 4. Combine and borrow

- **Layer another clip:** for example, *Sword attack* on the upper body over *Jog* creates a running attack.
- **Chain clips:** for example, Jump start → Jump → Jump land with crossfades.
- **Blend two clips:** for example, Walk + Run = jog.
- **Key poses → pose-to-pose copy:** a clean, sparse version of a captured clip that is easy to rework.
- **Retarget:** use another character's animations on yours. Bones are matched by anatomy, rotations are transferred relative to each rig's rest pose, and hip motion is scaled to the leg length.
  - *Keep proportions* adapts the motion to the target's body.
  - *Match limb directions* copies poses literally.
- **Import:** GLB clips with the same skeleton, AnimStudio clip `.json`, Mixamo `.fbx`, or a GLB with a different skeleton, which goes through retargeting.

## Give any model a skeleton (place the joints)

Use this for models that have no skeleton or whose bones aren't recognised (the Rig tab says "Partial"). Open it from **Tools › Build skeleton**, the Rig tab button, or the prompt shown when such a model loads.

1. **Auto-find** scans the mesh and places markers for the hips, chest, neck, head top, shoulders, elbows, wrists, hand tips, hip joints, knees, ankles and toes. It handles arms hanging down and T-/A-poses.
2. Check the markers in **Front** and **Side** view. To fix one, select it in the list (or click it), then click the model where that joint really is. The marker goes *inside* the body, the right side mirrors automatically, and the next marker is selected. You can also drag markers with the arrows.
3. Press **Build skeleton**. This creates a 30-bone humanoid skeleton with automatic skin weights, including three weapon sockets (see below). The rigged character is saved automatically as `AnimStudio/models/<name>_rigged.glb`. From then on, open that file (it's in the model list) so the rig survives reloads. Your clips are kept in the project.
4. Turn on **Weights** and click bones to check the skinning.
   - **Head moves as one piece** (on by default): the head follows only the Head bone, like most game rigs. Turning or nodding then never stretches the face, helmet or hair; only a short band at the neck blends between neck and head. Untick it for soft, squashy heads.
   - **Parts hanging off the head move with the head.** Helmet rims, hair, ponytails, ears and bandana tails count as head even where they reach down beside the shoulders. AnimStudio decides along the mesh surface, so a tail hanging from the head knot belongs to the head even where it lies on the shoulder. This matters for Meshy models, which are one welded mesh.
   - **Separate pieces** (armour plates, buttons) move as solid objects with the bone they sit on.
5. Press **✦ Moves** to put walks, runs, attacks, dances and more on it. You can also animate by hand with IK.

**Fix it later — Edit skeleton:** if an animation shows a joint in the wrong place (shoulder too high, knees off, hips too low), open **Rig tab › ✎ Edit skeleton** (or Tools › Build / edit skeleton). It starts from your current joints. Pick a joint in the list or click its dot, then click the model where it should be (or drag the yellow dot); *Mirror left → right* keeps both sides equal. Press **Update skeleton**: the skin is redone, **every clip is kept**, and hip heights in your clips move with the hips. Use *↻ Auto-fit* only if you want to start over.

Rigs with standard bone names (Mixamo `mixamorig:LeftArm`, Unreal `upperarm_l`, Blender `UpperArm.L`) are recognised automatically, so they can be retargeted without rebuilding.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| The head stretches, or parts of it (helmet sides, bandana, hair) swing with the arms | The skin was made by an older version, or the head option was off | **Rig tab › ✎ Edit skeleton → Update skeleton** (you don't need to move anything). Check with *Weights* → Head |
| The character stares at the floor in a walk or run | The source move leans the body and tips the head; on a big head that reads as looking down | ✦ Moves › ✎ Adjust the current clip › **Keep head level** 80–100% (and *Lean* about −8° if hunched) → *Replace* |
| A joint is in the wrong place (shoulder too high, knees off) | Marker placed off when the skeleton was built | **✎ Edit skeleton**, move the joint, **Update skeleton**. Clips are kept |
| The character floats or sinks in a move | Very different hip height between the source and your character | ✦ Moves › *Crouch*, or move the hips on *My edits* (one key shifts the whole clip) |
| Mixamo file looks bent or floats | A *Without Skin* download that stores an odd rest pose | Download **With Skin** instead |
| Ctrl+N opens a browser window | Browsers keep Ctrl+N | New clip is **Shift+N** (or **+ New**) |
| Changes I was told about don't show | The page still runs the old code | Press **F5** in the AnimStudio tab |

## Weapons & props

Characters that hold rifles, bazookas and so on get three **socket bones**. Sockets don't bend the mesh; they mark where a weapon goes:

| Socket | Where | Use |
|---|---|---|
| `Weapon_R` | right palm (grip point) | main weapon |
| `Weapon_L` | left palm | pistol / grenade / second weapon |
| `Weapon_Back` | behind the chest | holstered weapon |

- Skeletons made with **Build skeleton** have them already. For an older rig use **Tools › Add weapon sockets** (this also saves the rigged model).
- **Tools › Weapons & props…** (Ctrl+Shift+W) attaches a prop to a socket so you can animate against it. You can use the built-in placeholders (rifle, bazooka, pistol, grenade), any `.glb` in `AnimStudio/props`, or upload one with *From .glb file…*. Fine-tune the position, rotation and scale per prop; the settings are saved in the project.
- **Prop convention:** origin = where the main hand grips, **+Z** = muzzle, **+Y** = up. Model your weapons (e.g. in Blender) this way and they snap straight into the hand.
- Props are a **preview only** and are not exported with the character. In the game, attach your weapon scene to the same socket: Godot `BoneAttachment3D` (bone `Weapon_R`), Unity a child of the `Weapon_R` transform, Unreal a socket on that bone.
- **Weapon animation tip:** put aim / fire / reload on an *override layer* masked to the upper body. The legs then keep the Idle, Run or Jump underneath.

## ✦ Moves: the sliders

- **Adjust** with sliders instead of keyframes:
  - Speed; whole-body energy, arm swing, stride and bounce.
  - Lean, crouch (the feet stay planted), arms in/out, head up/down and head turn.
  - **Keep head level** (0–100%): real people keep their eyes on the horizon while the body leans and bobs. This cancels the head's nod and side tilt that come from the body, but keeps its left/right turns. Use 80–100% for big-headed characters, which otherwise seem to stare at the floor in walks and runs.
  - Smoothness and added life (wobble); Mirror and Loops.
  Double-click a slider to reset it.
- The recipe is stored with the clip, so **✎ Adjust the current clip** later reopens it with the same source and slider settings (your *My edits* layer is kept). It also works on any other clip.
- **★ My moves** are saved on AnimStudio's **standard skeleton**, a neutral humanoid the app generates itself, so they work on every character. Pick one, adjust it, and *★ Save these changes* to refine it. They're stored as `AnimStudio/library/*.move.json`.

## 🤖 Control AnimStudio with AI (MCP)

AnimStudio includes an MCP server (`mcp/server.mjs`, no extra installs). An AI assistant can then drive the **open** app live; you see every change in the viewport.

**Setup**
- **Claude Code:** the repository's `.mcp.json` registers it. Start Claude Code in the AnimStudio folder and approve "animstudio" (or run `/mcp`).
- **Claude Desktop:** add this to `claude_desktop_config.json`, with the full path to your AnimStudio folder:
  ```json
  { "mcpServers": { "animstudio": { "command": "node", "args": ["/path/to/AnimStudio/mcp/server.mjs"] } } }
  ```
- AnimStudio must be running (`start.bat`) with its browser tab open.

**What the AI can do** (42 tools)
- **Create brand-new motion:** `generate_motion` builds walk, run, jog, sprint, sneak, march, limp and idle cycles from scratch, with parameters for stride, knee lift, arm swing, bounce, lean, tempo and more. `regenerate_motion` tweaks them ("more knee lift").
- **Hand-animate:** `create_clip` and `key_pose` use anatomical angles (swing, spread and twist per bone, plus hip movement), so it can author attacks, gestures, jumps and so on pose by pose.
- **Restyle anything:** `adjust_motion` (the Move Maker sliders, including `headLevel`) and `apply_modifier` (smooth, amplify, noise, mirror, loop fix, plant feet…).
- **Use moves:** `list_moves` / `add_move` (animation packs or your ★ moves), `library_save`, `library_build_move`.
- **See its work:** `snapshot` returns a viewport image from any view and frame.
- **Project tasks:** `load_model`, `build_skeleton`, `export_glb`, `save_project`, `undo`/`redo`, plus `run_command` for any of the 120+ app commands.
- **Weapons:** `add_sockets`, `list_props`, `attach_prop` / `update_prop` / `remove_prop`, `key_weapon_pose` (place the weapon, IK puts both hands on it), `key_support_hand`, `save_rigged_model`.

Example requests: *"give me a new run, heavier and with more knee lift"*, *"make a 2-second overhead sword swing"*, *"make the idle look tired"*, *"export everything I made"*.

Scripts can use the same bridge: `POST http://localhost:5173/api/bridge/call` with `{"cmd":"generate_motion","args":{"type":"run"}}`.

## 5. Use it in your game

**Export GLB** (Ctrl+E):

- Choose the clips: the checked ones, only yours, only the current clip, or all.
- Choose *Model + animations* or *Animations only*.
- Choose the bake rate and the key reduction level.
- Optionally strip root motion, or write one file per clip.
- Layers and smooth curves are baked to standard linear keys.
- "Key every animated bone in every clip" stops poses from leaking between clips in engines.
- **Events** (Clip tab) such as footsteps or hit frames are written into the GLB (animation `extras`) and into a `<name>.events.json` sidecar, together with loop flags.

How to import the GLB:
- **Unity:** glTFast or UnityGLTF.
- **Godot:** import as a scene; the clips appear in the AnimationPlayer.
- **Unreal:** Import → glTF.
- **Blender:** File › Import › glTF.

**Projects** (Ctrl+S) store your edited and new clips, layers, events, pose library, bone names, and export choices. Unedited original clips are referenced rather than copied, so project files stay small. Work is autosaved every 45 s and offered back when you reopen the model.

---

## Shortcuts (most used)

| Key | Action | Key | Action |
|---|---|---|---|
| Space | Play / pause | K / Shift+K | Key selected / whole body |
| ← → | Previous / next frame | Alt+K | Delete key at playhead |
| , . | Previous / next key | Delete | Delete selected keys |
| Shift+← → | First / last frame | Ctrl+C / V | Copy / paste keys or pose |
| Q E W I | Select / Rotate / Move / IK | Ctrl+Shift+V | Paste mirrored |
| X | Local / world gizmo | M / Shift+M | Mirror to other side / flip pose |
| [ ] Ctrl+M | Parent / child / mirror bone | Ctrl+Z / Ctrl+Y | Undo / redo |
| 1 3 7 0 | Front / side / top / 3-4 view | Shift+N / Ctrl+D | New / duplicate clip |
| F | Frame selection | Ctrl+S / Ctrl+E | Save project / export |
| O T G | Onion / trail / ghost | Ctrl+K | Command palette |
| Home | Fit timeline | F1 / ? | Guide / shortcuts |

Timeline: drag the ruler to scrub · Shift+drag to set a range · Ctrl+wheel to zoom · Shift+wheel to pan · Alt+drag keys to scale them.

---

## For developers

```
AnimStudio/
  server.cjs            local server: static files, model list, projects, autosave, exports
  index.html, css/      UI shell and styles
  src/core/             engine (no DOM; also runs in Node)
    channel.js          keyframe channels, interpolation (linear/smooth/ease/step), sampling
    clip.js             clip/layer model, three.js conversion, baking, serialization
    evaluate.js         layer-stack evaluation (base/additive/override, masks, weights)
    keying.js           writes keys through the layer stack so the result equals the pose you see
    rig.js              skeleton analysis: anatomy labels, groups, mirror pairs, IK chains
    ik.js               analytic two-bone IK + CCD
    ops.js              modifiers and clip tools
    retarget.js         label + structure based bone mapping, rest-relative retargeting
                        (hip/root offsets go through model space, so Z-up Blender rigs work)
    style.js            Move Maker sliders (incl. keepHeadLevel)
    anatomy.js          swing / spread / twist pose controls that mean the same on any rig
    standard.js         AnimStudio's neutral standard skeleton + averaging of moves
    movecatalog.js      move names + categories (snake_case pack names map onto them)
    videomotion.js      (parked) video body landmarks -> clip on the standard rig
    analysis.js         motion profile, key poses, loop error, range of motion, trails
    history.js / project.js
  src/io/
    loader.js           GLB + FBX (Mixamo) loading; skeleton-only files; FBX hips/bind-pose fixes
    rigbuild.js         skeleton builder: auto-find markers, bones, automatic skin weights,
                        rigid head + headRegion() (surface-distance head/body split)
    packs.js            animation packs in animations/ (server list or animations/index.json)
    packbuild.js        ＋ Add animations: downloaded .fbx/.glb files -> one pack per skeleton
    exporter.js, library.js, animsource.js, api.js, sockets.js, propshapes.js, posetrack.js (parked)
  src/app/              state + events, commands, actions, modifiers runner, dialogs, session, AI bridge
  src/ui/               viewport, dope sheet, graph editor, panels, Move Maker, skeleton builder
                        (rigbuilder.js: build + Edit skeleton, keeps clips on update)
  animations/           animation packs (GLBs full of moves) for the Move Maker: yours, not in git
  vendor/mediapipe/     (parked video capture, not in git) MediaPipe Tasks Vision + pose models
  tests/                Node tests (npm test)
```

The design has four parts:
- **Copy-on-write clips:** every edit clones the touched clip, so undo and redo are just swaps of array references, and live previews are throwaway clones.
- **No build step:** native ES modules plus an import map for three.js.
- **One command registry:** menus, the palette, shortcuts, and buttons all run the same commands.
- **The core can be tested headlessly:** `npm test` (37 tests) covers rig labeling (by bone names and by skeleton shape), IK, layered keying, every modifier, retargeting, gait generation, building animation packs, weapon sockets, video-capture conversion, cycle averaging, keep-head-level and serialization. Tests that need no downloads use a character rigged by AnimStudio itself and generated motion. The rest need real animation data and are reported as *skipped* until you add the Quaternius *Universal Animation Library* packs as `animations/Quaternius Pack 1.glb` and `Quaternius Pack 2.glb` (see `tests/helpers.js`).

## Known limits

- Retargeting handles different skeletons well, but very different proportions (a chibi vs a tall human) can need small fixes, which the *My edits* layer is ideal for.
- glTF has no standard for animation events, so they live in `extras` and in the sidecar JSON.
- There is no FBX export. For FBX, import the GLB into Blender and export from there.
- The skeleton builder makes upright humanoids (two arms, two legs, one head); fingers, tails and wings aren't built.
- Motion from video is parked (the code is kept, the button is hidden). It needs MediaPipe Tasks Vision in `vendor/mediapipe/`, which is not in the repository.
