# AnimStudio changelog

Newest first. "Press F5" after an update means the browser tab must reload to run the new code; a server change needs `start.bat` (or `npm start`) to be restarted.

---

## 1.2.0 — 2026-10-18 — feet that stay put, ready for the game

Restart AnimStudio (`start.bat` / `npm start`), press F5, and restart your AI app so it sees the new tools.

- **No more sliding feet.** AnimStudio now knows when each foot is down: the heel lands, the foot rolls onto the ball, it pushes off. *Fix foot sliding* (Modify › Feet, or the Clip tab) pins every planted foot with leg IK, keeps the heel-toe roll, and stops feet sinking into the floor. Walks in place keep moving with the ground. On Quaternius and Mixamo walks, runs, sprints and crouches put on BandanaBot, feet that slid up to 13 cm now slide less than 1 cm.
- **✦ Moves plant the feet for you:** new picks have *Plant feet* on (untick it to keep a move as it is). The AI's `add_move` does the same.
- **Clip tab › Feet:** when each foot is down (orange where it slides), how far it slides, whether it sinks or floats, and the **speed to move the character at in your game** so its feet don't slide there either.
- **Footstep events:** *Add footstep events* puts `footstep_L` / `footstep_R` where each foot lands, for footstep sounds.
- **Generated gaits walked backwards.** `generate_motion` walks, runs, sneaks and marches lifted the knee while the leg swept back, so they moonwalked. They now walk forwards, with planted feet.
- **Moves that travel went twice as far** on characters with a root bone (every skeleton Build skeleton makes): a Mixamo roll or running jump put its travel on both the root and the hips. Add such moves again to get the fix.
- **Export for your engine:** *Export GLB › For* Godot, Unity, Unreal or Blender, with a short how-to for each. For Godot, looping clips are named `…-loop`, so Godot loops them on import and drops the suffix. *Travel › On the root bone* puts the travel on `Root` for root motion in the engine (or *In place*). The `.events.json` sidecar now also has each move's speed.
- **Root motion modifier › On the root bone**, optionally turning with the body, for moves that change direction.
- **Preview transitions** (Tools, Modify tab): Idle → Walk → Run played the way a game blends them, live in the viewport. Each step plays its times and crossfades into the next; moves that travel carry on. *Create clip* keeps it.
- **Motion capture (.bvh):** drop BVH files on a character, or add them as a pack with ＋ Add animations (CMU, Bandai Namco, Truebones, Rokoko exports…). Units are worked out from the skeleton's size; Z-up files are stood up.
- **Find best loop** (Modify › Motion): turns a long take into a seamless loop. It finds the stretch whose end flows back into its start, takes out the travel and smooths the seam.
- **AI (MCP):** new tools `analyze_clip` (foot sliding, sinking, loop seam, speed, with advice) and `sequence_clips`. `export_glb` takes `engine`, `root_motion`, `fps`, `reduce` and writes the sidecar. `apply_modifier` has `footplant`, `footsteps` and `findloop`. Every tool now has a title and read-only/destructive hints, and the server speaks MCP's new per-request protocol (2026-07-28) as well as the handshake versions.
- **Fixes:** the Move Maker's Adjust step showed a stray "null"; the AI's `add_move` left the *Base* layer active instead of *My edits*; the About box and status bar said 2.0.0. The server no longer serves dotfiles (`.git`, `.mcp.json`), and rejects broken autosaves instead of overwriting a good one.

## 1.1.0 — 2026-10-09 — no more floating characters

Restart AnimStudio (`start.bat` / `npm start`) and press F5. Moves added before this version keep their old motion: add them again from ✦ Moves to get the fix.

- **Mixamo-rigged characters no longer float.** On these skeletons the hips are the root bone, and moves from skeletons with a separate root bone (Quaternius and many others) lost all their hip motion: the character stood at full height and hovered over the floor.
- **Feet keep their ground contact** when a move goes onto another character. Hip movement is scaled by leg length (hip bones sit at different heights on different skeletons), and the lowest foot stays as high above the ground as in the original, frame by frame. Feet used to sink up to ~10 cm or hover up to ~20 cm.
- **Generated gaits touch the ground:** the sneak sank about 15 cm into the floor, and the march hovered.
- **Export: Feet at ground level (y = 0)**, on by default. Engines stand a character on its origin, and many models (e.g. Meshy) have it in the middle of the body.

## 1.0.0 — 2026-10-07 — first public release

AnimStudio is free and open source under the AGPL-3.0. It ships without characters or animations: you bring your own.

- **Characters:** open any `.glb`/`.fbx`; characters without animations get an empty clip to pose, and models without a skeleton get one bone per part.
- **Skeleton builder:** fit a reference skeleton with sliders and build a 30-bone humanoid with automatic skin weights. The head and everything hanging off it (helmet, hair, bandana) stay solid. Three weapon sockets come with it. **Edit skeleton** moves joints later and keeps every clip.
- **＋ Add animations:** drop Mixamo `.fbx` downloads or `.glb` animation packs on the start page. Files with the same skeleton go into one pack, and later downloads are added to it. A Mixamo character's skeleton is recognised even without skin.
- **✦ Moves:** preview any move from your packs on your character, adjust it with sliders (speed, energy, arms, stride, lean, crouch, keep head level, mirror, loop…) and add it with an empty *My edits* layer on top.
- **Editing:** drag joints (IK on hands and feet), gizmos, lock feet, mirror and flip, pose library, layers with masks, dope sheet, graph editor, undo/redo.
- **Modifiers:** exaggerate, smooth, add life, overlap, ease timing, loop fix, plant feet, root motion, key reduction.
- **Retargeting** between different skeletons, including Blender Z-up rigs and Mixamo. A skeleton with unnamed bones is recognised from its shape.
- **Export:** a GLB with model and animations (or animations only) for Godot, Unity, Unreal or Blender, with an events sidecar.
- **AI control:** an MCP server with 42 tools lets Claude drive the open app (generate gaits, key poses, adjust moves, snapshot, export).
