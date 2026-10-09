# AnimStudio changelog

Newest first. "Press F5" after an update means the browser tab must reload to run the new code; a server change needs `start.bat` (or `npm start`) to be restarted.

---

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
