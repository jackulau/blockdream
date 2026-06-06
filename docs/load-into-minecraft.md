# Loading mineworld block-art into Minecraft (Java **and** Bedrock)

Everything here is **100% vanilla** — no mods, no FAWE, no external tools. The CLI/web emit
real, droppable packs. The block-art plays as an animated wall of solid blocks, driven
entirely by command content (a `#minecraft:tick` datapack function on Java; `tick.json` +
a binary dispatch tree on Bedrock; or the Script API).

> For high-FPS *video on maps* and live world-model control, see
> [`live-control.md`](./live-control.md) and [`fps-budget.md`](./fps-budget.md) — those need
> the Java Fabric mod. This page is the cross-edition, mod-free path.

Generate everything:

```bash
# Java datapack (.zip + folder) — default target
mineworld render clip.gif --target datapack   --out ./out/dp
# Bedrock behavior pack (.mcpack + folder)
mineworld render clip.gif --target behaviorpack --out ./out/bp
# Bedrock Script-API addon (.mcpack + folder)
mineworld render clip.gif --target bedrock-script --out ./out/script
```

Each run prints exactly what to do next. `--speed <ticks>` sets playback rate (20 tps; `2`
→ 10 fps, `1` → 20 fps). `--grid WxH` sets the wall size.

---

## Java Edition (1.21+)

The emitter writes both a **folder** and a ready-to-drop **`<namespace>.zip`** (same content;
a zipped datapack is just as valid as a folder).

1. Find your world save folder:
   - **Singleplayer:** `.minecraft/saves/<World>/`
   - **Dedicated server:** `<server>/world/`
2. Copy `mineworld_art.zip` (or the unzipped folder) into `…/<World>/datapacks/`.
3. In game: run `/reload` (or rejoin the world).
4. Stand where you want the wall's bottom-left corner. The default origin is `0 64 0`,
   `+Z` facing — pass a custom origin when generating if needed.
5. `/function mineworld_art:setup` &nbsp;— one-time: scoreboards, force-loads the build area, paints frame 0.
6. `/function mineworld_art:start` &nbsp;— begin playback. `/function mineworld_art:stop` to pause.

What's inside the `.zip` (validated by `validateJavaDatapackArchive`):

```
pack.mcmeta                                  ← at archive ROOT
data/minecraft/tags/function/tick.json       ← runs the driver every tick
data/mineworld_art/function/setup.mcfunction
data/mineworld_art/function/driver.mcfunction
data/mineworld_art/function/frames/0.mcfunction …  ← keyframe + delta frames (fill-batched)
```

---

## Bedrock Edition

Bedrock has **no map-pixel API**, so the block-art plays as a solid-block wall. Two options:

### A) Vanilla behavior pack (`.mcpack`)

1. Double-click **`mineworld.mcpack`** → Minecraft imports it.
2. Create/edit a world → **Behavior Packs** → activate "mineworld block-art video".
3. Enter the world, stand at the build origin.
4. `/function mineworld/setup` then `/function mineworld/start` (`/function mineworld/stop` to pause).

(No experiments required — pure functions + `tick.json` + a `tickingarea` to keep chunks loaded.)

### B) Script-API addon (`.mcpack`) — smoother delta updates

1. Double-click **`mineworld-script.mcpack`** to import.
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

## Verifying without a client

Every pack is proven in CI without a running game:

- `packages/emit-commands/test/package.test.ts` — zips the pack, unzips it, and asserts the
  archive structure (root `pack.mcmeta` / `manifest.json`, tick wiring, namespaced functions).
- `packages/emit-commands/test/roundtrip2d.test.ts` and `bedrock-roundtrip.test.ts` —
  *simulate the emitted commands* (and the Script POOL) and reconstruct every animation
  frame, asserting it matches the source image cell-for-cell.

So "it's a valid, droppable pack" and "the animation reconstructs correctly" are both
machine-checked. Dropping it into a real client is the only operator step.
