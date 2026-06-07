# Importing animations → animated blocks

Make Minecraft blocks **follow a real animation** — a Blender export or a rendered video. Code in
`packages/voxel/src/gltf.ts` + `video3d.ts`, surfaced in the web demo's 3D section and the CLI.

The common thread: every frame is voxelized into **one shared world box** (the union of all frames'
bounds), so the model translates/rotates/deforms *in place* instead of being re-fit (and re-scaled)
each frame. That shared normalization is what makes the result a coherent animation rather than a
boiling mess.

## glTF / mesh sequences (best quality)

A Blender animation exported as glTF carries real 3D geometry, so the blocks follow the true shape.

- **`gltfToFrames(json, opts)`** — a focused glTF 2.0 reader (accessor decode, node TRS hierarchy,
  animation-channel sampling with quaternion slerp). Samples the animation at `opts.frames` times,
  bakes each into world space, and voxelizes solid.
- **`glbToFrames(arrayBuffer, opts)`** — binary `.glb` (Blender's default export): `parseGlb`
  splits the JSON + BIN chunks, then runs `gltfToFrames`.
- **`objSequenceToFrames(objs[], opts)`** — the classic OBJ-per-frame export (`frame_001.obj`,
  `frame_002.obj`, …); each frame is voxelized into the shared box.

In the web demo, the 3D section's import accepts `.gltf` / `.glb` / multiple `.obj` files. Tests:
`packages/voxel/test/gltf.test.ts` builds a real animated glTF + glb fixture in-memory and asserts
the model moves across frames.

## Video (MP4/GIF)

A rendered video has no depth, so each frame is reconstructed with the same silhouette-inflation
(or a real depth map) as a still image — see [3d-and-animation.md](./3d-and-animation.md).

- **`framesToAnimated3d(frames, opts)`** (`video3d.ts`) — each frame → a subject-isolated solid
  (not a flat slab), with **global** depth normalization (one shared max across the whole clip, so
  the build doesn't pop thicker/thinner) and an optional temporal EMA. `opts.depthForFrame` lets a
  monocular depth model or a Blender depth-pass sidecar drive natural footage.
- **Web:** `apps/web/src/video3d.ts` decodes a GIF, quantizes each frame, and calls the above →
  a real 3D block animation.
- **CLI:** `blockdream render <video> --target voxel3d` extracts frames (ffmpeg), voxelizes them,
  and writes an animated 3D datapack (delta-encoded + greedy-fill optimized). `--depth N` sets the
  build thickness.

Tests: `apps/web/test/video3d.test.ts` (temporal stability, motion-following) and the CLI
`voxel3d` target in `packages/cli/test/render.test.ts`.
