# Live cast: stream the world model into a running Minecraft world

The first-class way to "play the world model in Minecraft": **drop into a world that is
already open and watch the neural dream stream onto a block wall in place**, steered by your
own movement. No mod, no datapack, no `/reload`, no leaving the world. The static datapack
cast ([`play-without-fabric.md`](./play-without-fabric.md) → *Offline cast*) is the fallback
for when you want a fixed, shareable rollout; this page is the live one.

```bash
# one command, attaches to a world that's already running (see prereqs below)
bash scripts/cast-live.sh --rcon-pass <pass>
bash scripts/cast-live.sh --rcon-pass <pass> --skill elytra --origin 10,-60,10 --size 64x64
bash scripts/cast-live.sh --dry-run        # offline: synthetic walker, no MC / venv / ffmpeg
```

## The transport

The question "how do we get frames into the game live?" has a hard constraint: **nothing
inside vanilla Minecraft can open a socket** - not a datapack, not a command block, not the
Bedrock Script API. So the socket lives *outside* the game, in a sidecar process, and the
only mod-free way it can paint into a running world is the vanilla RCON protocol
(`setblock`/`fill`). One model port feeds every receiver:

```
 world-model server                  a live receiver paints in-world
 (ml serve.py)  ──ws://127.0.0.1:8765──┬─▶ RCON sidecar  → setblock/fill wall   mod-free, dynamic, model-bound fps
   1 PNG frame per action             ├─▶ Fabric mod     → MapState packets      high-fps (~20), needs JDK21 build
                                      └─▶ browser viewer → canvas                smooth display (apps/web)
```

- The **port** is the model's WebSocket on `ws://127.0.0.1:8765` (start it with
  `bash ml/scripts/serve_demo.sh`, which serves the `runs/skills_real` checkpoint). The wire
  contract is one request → one frame: send `{"type":"action","buttons":[…9…],"camera":[cx,cy],"skill":"walk"}`,
  receive `{"type":"frame","png_b64":…,"shape":[3,H,W]}`. A `{"type":"reset"}` re-seeds the rollout.
- The **RCON sidecar** ([`../packages/cli/src/rcon-bridge-cli.ts`](../packages/cli/src/rcon-bridge-cli.ts))
  is the mod-free in-world receiver: it polls your pose over RCON (`data get entity <you> Pos`/`Rotation`),
  derives the action from the pose delta (the unit-tested `deriveAction` contract shared with
  `serve.py` and the Fabric mod), steps the model over the WS port, and paints the returned
  frame as a vertical solid-block wall via `setblock`/`fill` commands sent back over RCON.
- Same port, other receivers: the **Fabric mod** ([`live-control.md`](./live-control.md)) consumes
  the identical WS contract in-JVM and swaps map pixels for ~20 fps; the **browser viewer**
  draws to a canvas. Pick the receiver; the model and protocol don't change.

## Drop-in: one command into a running world

`scripts/cast-live.sh` is the live counterpart to `scripts/cast.sh`. Where `cast.sh` *bakes*
a datapack you drop into a save and load, `cast-live.sh` *attaches* to a world that is already
open and paints in place. Two long-running prereqs (the script prints them if they're not up):

```bash
# terminal 1 - a stock vanilla server with RCON (prints the RCON password once)
bash scripts/vanilla-server.sh
# terminal 2 - the world-model WS server (ws://127.0.0.1:8765)
bash ml/scripts/serve_demo.sh
# terminal 3 - the live cast (this is cast-live.sh)
bash scripts/cast-live.sh --rcon-pass <pass>
```

Then join `localhost` with a Java 1.21.x client and move: the wall repaints with the model's
predicted frames, steered by your walking and looking. Key flags:

- **`--setup`** (on by default in `cast-live.sh`) clears the wall slab plus a few blocks of
  ±Z viewing clearance in the **running world** via `/fill … air` before streaming - so the
  dream appears cleanly wherever you point `--origin`, with nothing installed in the save.
- **`--rcon-conns <N>`** (default 4) is the throughput lever - see below.
- **`--skill <walk|sprint|jump|swim|boat|elytra|pig|minecart>`** switches the movement regime
  (needs the skill-conditioned `runs/skills_real` checkpoint).
- **`--origin x,y,z`** / **`--size WxH`** place and size the wall.

RCON cannot see keyboard state, so sprint/jump are *inferred* from speed and vertical motion,
and sneaking is never detected - the movement that reaches the model is what the server can
observe about your pose.

## Cast your own image or animation (not the model)

> One-command form: **`bash scripts/cast-asset.sh --image <path> --rcon-pass <pass> --setup`** (or
> `--build <path>` for 3D, `--animate spin` to animate). It wraps the `rcon-bridge-cli.ts` invocations
> below - no world-model server needed. The raw flags are documented here for reference.

The same mod-free RCON transport also paints **your own** picture - not only the world-model stream.
`--image <path>` decodes any still (`png`/`jpg`/`webp`) or animation (`gif`/`mp4`/`webm`) with ffmpeg
and paints it as a block wall in the running world, with the same `--origin` / `--facing` / `--setup`
placement controls and no datapack/reload. No world-model server is needed - this path skips the WS
port entirely (it is the live counterpart to baking a block-art datapack offline).

```bash
# a still image, placed at coords and facing east, clearing viewing space first
npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pass> \
  --image logo.png --size 64x64 --origin 100,70,-20 --facing east --setup

# a GIF/video looped as a LIVE animation (frame 0 keyframe, the rest deltas) at 8 fps, endless
npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pass> \
  --image clip.gif --size 48x48 --origin 100,70,-20 --fps 8 --loops 0

# preview the commands without touching a server
npx tsx packages/cli/src/rcon-bridge-cli.ts --dry-run --image logo.png --size 32x32
```

A still paints once; a multi-frame input loops `--loops` times (`<= 0` = endless) at `--fps`, each
frame sent as a delta off the previous so only changed blocks update. ffmpeg missing prints the same
clear `@blockdream/video` message as the rest of the pipeline.

`--image` paints a flat wall; **`--build <path>`** casts a real **3D build** instead - it inflates the
image to a depth-`--depth` solid (`imageToSolid`), orients it with `--facing`, and streams
`setblock`/`fill` at `--origin` that are byte-identical to the 3D datapack's keyframe (so casting live
equals baking + loading). `--setup` here clears the build's full W×H×D box, not a flat slab.

```bash
# a 3D build from an image, 12 voxels deep, placed and facing east, clearing the box first
npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pass> \
  --build photo.png --size 64x64 --depth 12 --origin 100,70,-20 --facing east --setup

# a SPINNING 3D build, live - a delta-encoded animation looped endlessly at 4 fps
npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pass> \
  --build logo.png --size 48x48 --depth 8 --origin 100,70,-20 --setup \
  --animate spin --animate-frames 24 --fps 4 --loops 0
```

`--animate <spin|explode|wave|buildup|...>` makes the live 3D build **move**: it bakes the build into a
volume sequence (`generateBaked`) and streams it delta-encoded over RCON (each frame byte-identical to
the 3D datapack's per-frame functions), repeating `--loops` times at `--fps`. `--setup` is folded into
each loop's first frame so a looping animation wraps cleanly.

A **`--build` with a video or GIF** (`.gif`/`.mp4`/`.webm`) is the *real-content* counterpart: every
decoded frame is inflated into its own 3D build and streamed as a delta-encoded live 3D animation - the
footage itself, in blocks, instead of a procedural spin. (`--animate` and a multi-frame `--build` are
mutually exclusive; a video is already its own animation.)

```bash
# a clip cast as a live 3D animation, looped at 6 fps
bash scripts/cast-asset.sh --build clip.mp4 --rcon-pass <pass> --depth 8 --fps 6 --loops 0 --setup
```

This completes the build-delivery matrix: a build reaches Minecraft offline (datapack / `.mcstructure`,
2D and 3D) and live (a 2D wall via `--image`, a 3D build via `--build`) - all honoring coordinates,
direction, and animation.

## Honest frame rates

The sidecar reports three rates separately every frame (and as a run summary) so they're never
conflated - `gen` · `paint` · `effective`:

- **gen** - how fast the *model* produces a frame. The served autoregressive checkpoint is
  ~2 fps (≈450 ms/frame on CPU; CPU beats MPS for this sequential token decode). This is the
  real mod-free content ceiling today.
- **paint** - how fast the sidecar *writes* the frame in-world over RCON. `rcon-client`
  serializes one socket, so a single connection paints a frame's commands one round-trip at a
  time; the **pool of `--rcon-conns` connections** sends them concurrently (M commands cost
  ≈ ceil(M/N) round-trips), so paint stops being the bottleneck and the live rate falls back to
  what the model and the server can sustain rather than to client round-trip latency.
- **effective** - end-to-end frames you actually see, bounded by the slower of gen/paint and
  the `--fps` cap.

So the honest mod-free number is **model-bound, ~2 fps for the AR checkpoint** - genuinely
live, not smooth video. The MC server still executes the `setblock`/`fill` commands on its main
thread, so the pool lifts the *client* ceiling, not the server's; per-technique numbers are in
[`fps-budget.md`](./fps-budget.md).

## Going faster

Two independent ceilings, two fixes:

- **Raise gen** → the few-step **diffusion** checkpoint generates frames roughly independent of
  resolution (`ml/scripts/bench_inference.py` measures ~47 fps on a CPU floor vs ~4 fps for the
  sequential AR path). Serving a diffusion MC checkpoint lifts the content rate past 2 fps; the
  sidecar transport is unchanged. (Operator step - the AR path is what ships trained today.)
- **Raise paint / go smooth** → the **Fabric mod** ([`live-control.md`](./live-control.md))
  swaps each map's 16384-byte colour array per tick instead of issuing block updates - real
  video on an item-frame map wall at up to ~20 fps, with the same live WM control over the same
  WS port. It needs a JDK 21 build (`bash scripts/fabric-install.sh`); the no-mod RCON cast
  above needs none of that. 30 fps full-screen in real Minecraft is not physically available -
  see [`fps-budget.md`](./fps-budget.md) for why.
