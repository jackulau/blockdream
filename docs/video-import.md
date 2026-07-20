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

## Recreating a WHOLE video (faithful wall + full-length song)

The relief pipeline above is for lifting a *subject* into 3D. To reproduce a **whole video,
frame-for-frame** (the "play Bad Apple!! in Minecraft" use case), use the faithful modes:

```bash
# 3:39 video → 4381-frame block wall at 20 fps (the in-game ceiling) + FULL song + LED glow
blockdream render badapple.mp4 --target voxel3d --wall --led \
  --grid 96x72 --fps 20 --music on --max-notes 8000 --out ./badapple-wall

# same video as a TRUE-RGB screen: exact source colors, no palette, no dither
blockdream render badapple.mp4 --target rgbscreen \
  --grid 64x48 --fps 20 --music on --max-notes 8000 --out ./badapple-rgb
```

Packs this size are ~1.6-1.8M commands: give the server **4G+ heap** and
**`max-tick-time=-1`** (`scripts/vanilla-server.sh` sets both) or `/reload` will OOM or trip
the watchdog. Prefer lighter packs? Drop to `--fps 10` for half the commands.

### The 20 fps in-game ceiling (honesty note)

Minecraft executes **one animation step per game tick**, and the game runs at 20 ticks per
second - so **20 fps is the physical playback ceiling** for a datapack (`--speed 1`). The web
demo can decode and *preview* a clip at 30 or 60 fps, but a datapack export **resamples evenly
down to 20 fps** so the in-game clip runs the same wall-clock duration as the source (frames
are skipped, time is never stretched). The export status line says when this happened. Clips
at or below 20 fps keep every frame, each dwelling its nearest whole-tick duration. The CLI
does the same (shared planner): a `--fps 30`/`--fps 60` render resamples evenly to 20 fps and
says so in its output - `--fps 20` is the highest rate that plays 1:1 in game. An explicit
`--speed` opts out of the resample (raw pacing requested).

- **`--wall`** (voxel3d) - every pixel becomes exactly one block, background included
  (`framesToFlat3d`), instead of subject isolation + relief. The frames ARE the video.
- **`--led`** (voxel3d) - an invisible `minecraft:light[level=15]` plane one block in front of
  the wall (fill mode `keep`, placed once in setup), so the wall reads like a lit LED screen at
  night. There is no vanilla "RGB/LED block" - this is the honest vanilla equivalent.
- **`--target rgbscreen`** - vanilla has **no RGB block** (verified against every 2026 drop:
  26.1 "Tiny Takeover", 26.2 "Chaos Cubed" sulfur/cinnabar, the 26.3 poplar snapshots - all
  fixed palettes; true 16.7M-color *blocks* exist only in mods). But a `text_display` entity's
  `background` is a full ARGB int, so a one-entity-per-pixel grid IS an exact-color screen:
  deterministic per-pixel UUIDs, frames as `data merge entity <uuid> {background:<argb>}`
  deltas, full-bright (`brightness:{sky:15,block:15}`), `:teardown` removes every entity.
  `--rgb-levels` (default 32) posterizes so codec noise doesn't bloat deltas; `--px-scale`
  tunes the quad size if your client's font metrics show seams. Client-side cost scales with
  pixel count - 64×48 = 3072 display entities is comfortable; go much larger with care.
- **Full-length music** - `--max-notes` lifts the sequencer cap (default 1500), and the music
  loop is **locked to the animation loop** (`#mtcount = frames × speedTicks`, notes past the
  loop trimmed): audio and video wrap together forever instead of drifting apart each cycle.
- One blockdream animation pack at a time per world: the packs share the `ma` scoreboard
  clock. Disable one (`/datapack disable`) before setting up another.

Proven end-to-end on a real vanilla 1.21.1 server by
`tools/mineflayer-collector/fullvideo-e2e.mjs` (boot-load + /reload, cell-exact frame-0, LED
plane, locked music clock, live macro-dispatched animation for BOTH targets, entity-exact RGB
pixels, clean teardown). Run it: `node tools/mineflayer-collector/fullvideo-e2e.mjs`; point it
at a real video with `E2E_INPUT=/path/video.mp4 E2E_GRID=96x72 E2E_FPS=10 E2E_MAX_FRAMES=0`.

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
