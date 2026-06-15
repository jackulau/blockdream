# Loading blockdream block-art into Minecraft (Java **and** Bedrock)

Everything here is **100% vanilla** - no mods, no FAWE, no external tools. The CLI/web emit
real, droppable packs. The block-art plays as an animated wall of solid blocks, driven
entirely by command content (a `#minecraft:tick` datapack function on Java; `tick.json` +
a binary dispatch tree on Bedrock; or the Script API).

> For high-FPS *video on maps*, see [`live-control.md`](./live-control.md) and
> [`fps-budget.md`](./fps-budget.md) - that path needs the Java Fabric mod. Live
> world-model control also works **without** any mod via the ~2 fps RCON sidecar
> ([`play-without-fabric.md`](./play-without-fabric.md)). This page is the cross-edition,
> mod-free path.

Generate everything:

```bash
# Java datapack (.zip + folder) - default target
blockdream render clip.gif --target datapack   --out ./out/dp
# Bedrock behavior pack (.mcpack + folder)
blockdream render clip.gif --target behaviorpack --out ./out/bp
# Bedrock Script-API addon (.mcpack + folder)
blockdream render clip.gif --target bedrock-script --out ./out/script
```

Each run prints exactly what to do next. `--speed <ticks>` sets playback rate (20 tps; `2`
→ 10 fps, `1` → 20 fps). `--grid WxH` sets the wall size.

---

## Java Edition (1.21+)

> **One command, straight from the world model:** `bash scripts/cast.sh` rolls the WM and
> emits a droppable `blockdream.zip` datapack (preflights venv/ffmpeg/checkpoint for you) -
> see [`play-without-fabric.md`](./play-without-fabric.md). No world to drop it into?
> `bash scripts/vanilla-server.sh --datapack <zip>` bootstraps a throwaway localhost
> vanilla 1.21.1 server with the pack pre-installed.

The emitter writes both a **folder** and a ready-to-drop **`<namespace>.zip`** (same content;
a zipped datapack is just as valid as a folder).

1. Find your world save folder:
   - **Singleplayer:** `.minecraft/saves/<World>/`
   - **Dedicated server:** `<server>/world/`
2. Copy `blockdream.zip` (or the unzipped folder) into `…/<World>/datapacks/`.
3. In game: run `/reload` (or rejoin the world).
4. The wall builds at the fixed origin `0 64 0` on the `z=0` plane (`+Z` facing) - fly
   there to watch it. (A custom origin is an API option, `DatapackOptions.origin`, not a
   CLI flag.)
5. `/function blockdream:setup` &nbsp;- one-time: scoreboards, force-loads the build area, paints frame 0.
6. `/function blockdream:start` &nbsp;- begin playback. `/function blockdream:stop` to pause.

The 3D target works the same way with its own namespace: `blockdream render img.png
--target voxel3d` emits `blockdream_3d.zip` → `/function blockdream_3d:setup` then
`/function blockdream_3d:start`.

What's inside the `.zip` (validated by `validateJavaDatapackArchive`):

```
pack.mcmeta                                  ← at archive ROOT (pack_format + supported_formats)
data/minecraft/tags/function/tick.json       ← runs the driver every tick
data/blockdream/function/setup.mcfunction    ← scoreboards + forceload + keyframe
data/blockdream/function/driver.mcfunction   ← frame clock + vanilla-macro dispatch
data/blockdream/function/play.mcfunction     ← $function blockdream:frames/$(idx)
data/blockdream/function/start.mcfunction / stop.mcfunction
data/blockdream/function/frames/0.mcfunction …  ← keyframe + delta frames (fill-batched)
```

---

## Bedrock Edition

Bedrock has **no map-pixel API**, so the block-art plays as a solid-block wall. Two options:

### A) Vanilla behavior pack (`.mcpack`)

1. Double-click **`blockdream.mcpack`** → Minecraft imports it.
2. Create/edit a world → **Behavior Packs** → activate "blockdream block-art video".
3. Enter the world, stand at the build origin.
4. `/function blockdream/setup` then `/function blockdream/start` (`/function blockdream/stop` to pause).

(No experiments required - pure functions + `tick.json` + a `tickingarea` to keep chunks loaded.)

### B) Script-API addon (`.mcpack`) - smoother delta updates

1. Double-click **`blockdream-script.mcpack`** to import.
2. Activate the behavior pack on your world **and enable the "Beta APIs" experiment**
   (the Script API requires it).
3. In chat: `!mw start` to play, `!mw stop`, `!mw reset`.

What's inside an `.mcpack` (validated by `validateBedrockMcpackArchive`):

```
manifest.json        ← at archive ROOT (header.uuid + modules[].uuid, format_version 2)
functions/…          ← behavior-pack path,  OR
scripts/main.js      ← script-addon path
scripts/frames.js
```

---

## Casting the world model's dream (offline)

You can also feed the pipeline straight from the **neural world model** - no source clip
needed. The one-command path is the wrapper script (works from anywhere; preflights
venv / ffmpeg / checkpoint and passes the absolute checkpoint path for you):

```bash
bash scripts/cast.sh --skill walk --steps 24 --out /tmp/wmcast
# → /tmp/wmcast/blockdream.zip - drop into <World>/datapacks/, /reload,
#   /function blockdream:setup, then start playback as above
# (no world handy? bash scripts/vanilla-server.sh --datapack /tmp/wmcast/blockdream.zip)
```

Under the hood it runs `ml/scripts/cast_wm_to_datapack.py`, which rolls the
skill-conditioned WM checkpoint N steps, encodes the generated frames with ffmpeg, and
drives the same CLI to emit a vanilla Java datapack animation of the dream. This is the
**offline twin** of the live paths: the RCON sidecar / Fabric mod
(see [`play-without-fabric.md`](./play-without-fabric.md) / [`live-control.md`](./live-control.md))
stream and *control* the WM in a running game, while this casts a fixed rollout into a
mod-free, shareable datapack. Smoke-tested in `ml/tests/test_cast_datapack.py`.

---

## Verifying without a client

Every pack is proven in CI without a running game:

- `packages/emit-commands/test/package.test.ts` - zips the pack, unzips it, and asserts the
  archive structure (root `pack.mcmeta` / `manifest.json`, tick wiring, namespaced functions).
- `packages/emit-commands/test/roundtrip2d.test.ts` and `bedrock-roundtrip.test.ts` -
  *simulate the emitted commands* (and the Script POOL) and reconstruct every animation
  frame, asserting it matches the source image cell-for-cell.

And the Java path is additionally proven against a **real vanilla server** - no client,
no mods: `tools/mineflayer-collector/datapack-e2e.mjs` renders a clip through the actual
CLI, installs the `.zip` into a throwaway stock 1.21.1 server, and asserts over RCON that
the pack is enabled (boot **and** after `/reload`), that `setup` paints the keyframe
**cell-exactly**, and that `start` really animates (the tick driver's macro dispatch
executes delta frames). Run it yourself:

```bash
BLOCKDREAM_E2E=1 bash scripts/verify-all.sh    # or directly:
node tools/mineflayer-collector/datapack-e2e.mjs
```

So "valid droppable pack", "animation reconstructs correctly", **and** "a stock vanilla
server actually executes it" are all machine-checked. (Bedrock has no headless
server on macOS - its packs are validated by the simulators above; importing into a real
Bedrock client is the one remaining operator step.)
