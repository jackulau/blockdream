# Importing animations → animated blocks

Make Minecraft blocks **follow a real animation** - a Blender export or a rendered video. Code in
`packages/voxel/src/gltf.ts` + `video3d.ts`, surfaced in the web demo's 3D section and the CLI.

The common thread: every frame is voxelized into **one shared world box** (the union of all frames'
bounds), so the model translates/rotates/deforms *in place* instead of being re-fit (and re-scaled)
each frame. That shared normalization is what makes the result a coherent animation rather than a
boiling mess.

## glTF / mesh sequences (best quality)

A Blender animation exported as glTF carries real 3D geometry, so the blocks follow the true shape.

- **`gltfToFrames(json, opts)`** - a focused glTF 2.0 reader (accessor decode, node TRS hierarchy,
  animation-channel sampling with quaternion slerp). Samples the animation at `opts.frames` times,
  bakes each into world space, and voxelizes solid.
- **`glbToFrames(arrayBuffer, opts)`** - binary `.glb` (Blender's default export): `parseGlb`
  splits the JSON + BIN chunks, then runs `gltfToFrames`.
- **`objSequenceToFrames(objs[], opts)`** - the classic OBJ-per-frame export (`frame_001.obj`,
  `frame_002.obj`, …); each frame is voxelized into the shared box.

In the web demo, the 3D section's import accepts `.gltf` / `.glb` / multiple `.obj` files, animated `.gif`,
and **video files** (`.mp4`, `.webm`, `.mov`) decoded natively by the browser's own video engine
(no ffmpeg, no WASM). Tests:
`packages/voxel/test/gltf.test.ts` builds a real animated glTF + glb fixture in-memory and asserts
the model moves across frames.

## Video (MP4/GIF)

A rendered video has no depth, so each frame is reconstructed with the same silhouette-inflation
(or a real depth map) as a still image - see [3d-and-animation.md](./3d-and-animation.md).

- **`framesToAnimated3d(frames, opts)`** (`video3d.ts`) - each frame → a subject-isolated solid
  (not a flat slab), with **global** depth normalization (one shared max across the whole clip, so
  the build doesn't pop thicker/thinner) and an optional temporal EMA. `opts.depthForFrame` lets a
  monocular depth model or a Blender depth-pass sidecar drive natural footage.
- **Web:** the 3D viewer accepts `.gif` AND any browser-decodable **video** (`.mp4`/`.webm`/`.mov`
  via `apps/web/src/video.ts`). Each decoded frame is quantized and passed to `framesToAnimated3d`.
  `planFrameTimes` (unit-tested, pure) handles frame-rate sampling and clamping so the last seek
  never hangs on an exact-duration timestamp.
- **CLI:** `blockdream render <video> --target voxel3d` extracts frames via **ffmpeg** (required;
  install with `brew install ffmpeg` or `apt-get install ffmpeg` — a missing binary is caught early
  with a clear install hint instead of a raw ENOENT). Key flags:
  - `--depth N` — build thickness in blocks (default 8)
  - `--smooth 0..1` — temporal depth smoothing between frames (default 0.35)
  - `--curve N` — thickness profile exponent (default 0.5; <1 rounds the dome)
  - `--animate explode|wave|buildup` — **procedural block-motion** of the built solid. Animates a
    still image or 3D model; for a clip, animates the first frame. `--animate-frames N` (default 24)
    controls the length of the generated sequence.

**Procedural block-motion (`--animate`):** the same `explode`, `wave`, and `buildup` generators
available in the web demo's animation selector are now reachable from the CLI for any 3D target.
Example — make a PNG image explode and reassemble as a 3D Minecraft build:

```bash
blockdream render my-image.png --target voxel3d --animate explode --animate-frames 24 --out ./explode-build
```

Tests: `apps/web/test/video3d.test.ts` (temporal stability, motion-following),
`apps/web/test/video-decode.test.ts` (frame-time sampling, format detection),
`packages/cli/test/video3d-e2e.test.ts` (volumes move between frames, full product assertion),
and `packages/cli/test/animate-cli.test.ts` (explode/wave/buildup wired to voxel3d/mcstructure3d/model3d).
