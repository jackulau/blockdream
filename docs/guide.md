# The Blockdream guide — image/GIF/video → blocks in vanilla Minecraft

Zero to an animated block wall in your own world, end to end. Everything on this page is
**100% vanilla** — no mods, no external tools; the deeper docs are linked where you might
want them. (Want the *neural world model* in Minecraft instead of your own media? Same
import flow — see [Cast the world model](#cast-the-world-model-instead-of-a-clip) below.)

## Install

```bash
git clone https://github.com/jackulau/blockdream && cd blockdream
pnpm install
pnpm -r --filter "./packages/**" build
alias blockdream='npx tsx packages/cli/src/index.ts'   # how this guide invokes the CLI
```

That's the whole renderer — Node only. (`ffmpeg` on PATH is needed to decode
images/GIFs/video: `brew install ffmpeg` / `apt install ffmpeg`.) The ML world-model side
is optional and has its own [quickstart](../README.md#quickstart-fresh-clone).

## Generate

One command; every target prints exactly what to do next:

```bash
blockdream render cat.png                      # image  → Java datapack (the default target)
blockdream render clip.gif  --speed 2          # GIF    → animated datapack (2 ticks/frame = 10 fps)
blockdream render demo.mp4  --max-frames 200   # video  → animated datapack, capped frames
blockdream render cat.png   --target voxel3d --depth 8     # image → real 3D voxel build
blockdream render clip.gif  --target behaviorpack          # Bedrock .mcpack instead
```

Useful knobs: `--grid WxH` (wall size, default `64x64`), `--fps n` (sample rate),
`--dither floyd-steinberg|bayer|none`, `--out dir` (default `./out/<target>`). Preview
without entering the game: `blockdream preview cat.png --out preview.png` renders a
side-by-side source | block-art PNG.

## Choose a target

| Target | You get | Plays in | Best for |
|---|---|---|---|
| `datapack` *(default)* | `blockdream.zip` | **Vanilla Java** | 2D image/video wall of real blocks — the standard choice |
| `voxel3d` | `blockdream_3d.zip` | **Vanilla Java** | real 3D builds + 3D animation from an image/video ([how it works](./3d-and-animation.md)) |
| `behaviorpack` | `blockdream.mcpack` | **Vanilla Bedrock** | the same block wall on phones/consoles/Win10 |
| `bedrock-script` | `blockdream-script.mcpack` | Bedrock + “Beta APIs” toggle | smoother Bedrock playback (Script API) |
| `mcstructure` / `mcstructure3d` | `.mcstructure` file(s) | Bedrock structure block | static art / 3D models you place yourself |
| `map` | `map_N.dat` file(s) | Vanilla Java or Bedrock | pixel-perfect 128×128 map items (item-frame walls) |
| `mwframes` | `frames.bin` pool | Java + the optional [Fabric mod](../mods/java-fabric/README.md) | high-FPS video on a map wall (~20 fps) |

Rule of thumb: **vanilla Java → `datapack`** (or `voxel3d` for 3D), **vanilla Bedrock →
`behaviorpack`**. Command-count/FPS budgets and what “too big” looks like:
[vanilla command budgets](./vanilla-command-budgets.md) · [fps budget](./fps-budget.md).

## Pick a Minecraft version

Usually you don't have to: Java datapacks declare `supported_formats`, so the same
`blockdream.zip` loads on the **whole Java 1.21.x line (1.21 → 1.21.10)** with no
“incompatible pack” warning, and Bedrock packs use a forward-compatible **1.21.0 floor**.
`--version 1.21.5` pins an exact `pack_format`/`DataVersion` if you want the stamp to
match one release; an unsupported version fails fast and prints the supported list.
Details: [README — version support](../README.md#minecraft-version-support).

## Import into Java (vanilla)

1. Find your world's save folder:
   - Singleplayer: `.minecraft/saves/<World>/`
   - Server: `<server>/world/`
2. Copy **`blockdream.zip`** into `…/<World>/datapacks/`.
3. In game: `/reload` (or rejoin the world).
4. `/function blockdream:setup` — one-time: scoreboards, force-loads the area, paints frame 0.
5. `/function blockdream:start` — play. `/function blockdream:stop` — pause.

The wall builds at the fixed origin **`0 64 0`** (on the `z=0` plane, facing +Z) — fly
there. For a `voxel3d` pack the namespace is `blockdream_3d`
(`/function blockdream_3d:setup` … `:start`). No world handy?
`bash scripts/vanilla-server.sh --datapack out/datapack/blockdream.zip` bootstraps a
throwaway localhost vanilla server with the pack pre-installed.

## Import into Bedrock (vanilla)

1. Double-click **`blockdream.mcpack`** — Minecraft imports it.
2. World settings → **Behavior Packs** → activate “blockdream block-art video”.
3. In game: `/function blockdream/setup` then `/function blockdream/start`
   (note Bedrock uses `/` in function paths, not `:`).

No experiments needed for the behavior pack. The `bedrock-script` variant instead needs
the **Beta APIs** experiment, then chat `!mw start` / `!mw stop`. `.mcstructure` files
load with a structure block or a world-editing tool. Full Bedrock detail (and what's
inside each pack): [load into Minecraft](./load-into-minecraft.md).

## Cast the world model (instead of a clip)

The neural world model feeds the **same import flow** — roll it offline into a datapack,
or paint it live over RCON while your movement steers it:

```bash
bash scripts/cast.sh --skill walk --steps 24   # → blockdream.zip, import as above
```

Live, mod-free control (~2 fps, three terminals) and the optional high-FPS Fabric path:
[play without Fabric](./play-without-fabric.md) · [live control](./live-control.md).

## Troubleshooting

**“Unknown function blockdream:setup”** — the pack isn't loaded:
- The zip must sit in `…/<World>/datapacks/` (per-world — not `.minecraft/datapacks/`), then `/reload`.
- `/datapack list` must show `[file/blockdream.zip]` under the enabled packs. Listed as
  disabled? `/datapack enable "file/blockdream.zip"`.
- If you unzipped and re-zipped it, make sure `pack.mcmeta` is at the **archive root**
  (no extra folder layer). Easiest: use the emitted zip or the emitted folder as-is.

**Can't run `/function` at all** — you need command permission: singleplayer requires
cheats (world setting, or *Open to LAN → Cheats ON* for an existing world); on a server,
run it as an op or from the server console.

**Red “incompatible pack” warning** — shouldn't happen on Java 1.21.x (the pack declares
`supported_formats`). On older snapshots/releases (< 1.21) the macro-based driver isn't
supported; on a newer line, regenerate with the matching `--version`.

**Pack loads, but no blocks appear** — did you run `…:setup`? It paints frame 0 even in
unloaded chunks (it force-loads the strip). The wall is at `0 64 0`, `z=0` plane — it
builds *in the air* there; fly to it. Coordinates occupied by your builds? The wall
overwrites the plane it paints — generate in a fresh world or relocate your build.

**Animation doesn't advance** — `setup` only paints frame 0; run
`/function blockdream:start`. Single images have one frame (nothing to animate). If chat
spams command feedback, `/gamerule sendCommandFeedback false`.

**It's slow / the server lags** — shrink the wall (`--grid 48x36`), slow the clock
(`--speed 4` = 5 fps), or cap frames (`--max-frames 100`). The defaults (64×64 @ 10 fps,
delta-encoded + `/fill`-batched) are tuned to stay well inside vanilla's per-tick budget:
[vanilla command budgets](./vanilla-command-budgets.md).

**Bedrock import does nothing** — import the `.mcpack` again (Minecraft shows an “Import
successful” toast), activate it under **Behavior Packs** *on that world*, and remember
Bedrock function paths use `/function blockdream/setup` (slash, not colon).

## Is this actually proven?

Yes — beyond unit tests, a live gate renders a clip through this exact CLI, installs the
zip into a **stock vanilla 1.21.1 server**, and asserts over RCON that the pack loads
(boot + `/reload`), `setup` paints the keyframe **cell-exactly**, and `start` really
animates: `BLOCKDREAM_E2E=1 bash scripts/verify-all.sh` (or run
`node tools/mineflayer-collector/datapack-e2e.mjs` directly). Sim-level reconstruction
proofs for every other target: [load into Minecraft](./load-into-minecraft.md#verifying-without-a-client).
