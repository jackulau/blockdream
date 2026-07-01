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
  install with `brew install ffmpeg` or `apt-get install ffmpeg` - a missing binary is caught early
  with a clear install hint instead of a raw ENOENT). Key flags:
  - `--depth N` - build thickness in blocks (default 8)
  - `--smooth 0..1` - temporal depth smoothing between frames (default 0.35)
  - `--curve N` - thickness profile exponent (default 0.5; <1 rounds the dome)
  - `--animate explode|wave|buildup` - **procedural block-motion** of the built solid. Animates a
    still image or 3D model; for a clip, animates the first frame. `--animate-frames N` (default 24)
    controls the length of the generated sequence.

**Procedural block-motion (`--animate`):** the same `explode`, `wave`, and `buildup` generators
available in the web demo's animation selector are now reachable from the CLI for any 3D target.
Example - make a PNG image explode and reassemble as a 3D Minecraft build:

```bash
blockdream render my-image.png --target voxel3d --animate explode --animate-frames 24 --out ./explode-build
```

Tests: `apps/web/test/video3d.test.ts` (temporal stability, motion-following),
`apps/web/test/video-decode.test.ts` (frame-time sampling, format detection),
`packages/cli/test/video3d-e2e.test.ts` (volumes move between frames, full product assertion),
and `packages/cli/test/animate-cli.test.ts` (explode/wave/buildup wired to voxel3d/mcstructure3d/model3d).

## Audio → note blocks

When the imported video **has an audio track**, the build can come with **Minecraft note blocks that
play that audio**. The audio is transcribed to a melodic note-block line (monophonic - the dominant
pitch per ~50 ms hop) and emitted into the 3D voxel datapack as a **physical "music area"** (one tuned
`note_block[note=N,instrument=…]` per note, on its instrument base block with air above so it is
audible - visible and editable in-world) plus an **engine** that strikes those note blocks in time.
Two engines, chosen with `--music-engine` (default `playsound`):

- **`playsound`** (default) - a tick-driven sequencer (`music.mcfunction`) plays the melody with
  positional `playsound` on the same scoreboard clock as the build animation. Robust vanilla audio,
  smallest footprint, no wiring. Byte-identical to the pre-`--music-engine` output.
- **`redstone`** - a **physical repeater delay-line** is built beside the note blocks. A pulse enters
  one end and propagates down a spine of repeaters; each note's onset is quantised to the redstone grid
  (1 redstone tick = 2 game ticks) and realised by repeater delay (1..4 rt each, chained for longer
  gaps), so the pulse strikes each note block on its rising edge exactly on time. The build literally
  plays itself; `music.mcfunction` shrinks to a once-per-loop re-pulse metronome. Bigger footprint,
  100 ms timing granularity. Proven end-to-end on a real 1.21.1 server
  (`tools/mineflayer-collector/redstone-music-e2e.mjs`, `BLOCKDREAM_E2E=1`).

The analysis core is `@blockdream/audio` (`analyzeAudio(pcm, sampleRate, opts) → NoteEvent[]`):
autocorrelation pitch detection with YIN-style octave correction, RMS-gated onsets (silence yields no
note), folded into the note block's two-octave range (F#3..F#5, indices 0..24). It is pure and
DOM-free, shared by both the CLI and the browser.

- **CLI:** `blockdream render <video> --target voxel3d --music auto|on|off`
  - `--music auto` (default) - include note blocks **iff** the video carries an audio track
  - `--music on` / `--music off` - force or suppress; an audio-less video is always music-free
  - `--instrument <name>` - note-block instrument (default `harp`; `bass`, `bell`, `flute`, `chime`,
    `guitar`, `xylophone`, `pling`, …)
  - `--music-origin x,y,z` - where the music area spawns (default: beside the build)
  - `--music-engine playsound|redstone` - how the note blocks are struck (default `playsound`; see above)

  ```bash
  blockdream render clip.mp4 --target voxel3d --music on --instrument bell --out ./build-with-music
  # build a self-playing redstone instrument instead of a playsound clock:
  blockdream render clip.mp4 --target voxel3d --music on --music-engine redstone --out ./redstone-music
  ```

- **Web (builder canvas mod):** importing a video auto-decodes its audio (Web Audio
  `decodeAudioData`, no ffmpeg) and drops the note-block **music area** next to the build. An
  **Arrange** mode lets you drag the build (the animation) and the music area **independently** on the
  ground plane (orbit is suspended mid-drag), and a **Note blocks** checkbox toggles them on/off. The
  datapack download carries whatever you arranged: build origin = the animation's position, music
  origin = the music area's position, and note blocks are included only when the toggle is on (off ⇒
  byte-identical to a music-less build).

Tests: `packages/audio/test/analyze.test.ts` (pitch detection on synthesized sines/scales),
`packages/video/test/audio.test.ts` (ffmpeg PCM extraction), `packages/emit-commands/test/note-sequencer.test.ts`
(note-block placement + playsound + additive datapack),
`packages/emit-commands/test/redstone-sequencer.test.ts` (the redstone delay-line emitter - repeater
delays, tuned note blocks, cumulative-delay == onset), `packages/cli/test/music-cli.test.ts`
(`--music` / `--music-engine` end-to-end), `apps/web/test/audio.test.ts` (browser decode→analyze glue),
`apps/web/test/canvas-mod.test.ts` (drag/projection/toggle math), and
`apps/web/test/datapack-export.test.ts` (the arranged music carried into the export).
