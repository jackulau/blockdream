# Playing the world model WITHOUT Fabric (no mods at all)

You do **not** need Fabric — or any mod — to put the neural world model inside Minecraft.
The two primary paths below run against **stock vanilla Java**: one is fully offline
(a droppable datapack animation of a WM rollout), one is **live** (your in-game movement
drives the model in real time over RCON). The Fabric mod still exists, but only as the
optional high-FPS upgrade at the bottom of this page.

| | Offline cast (datapack) | Live bridge (RCON) | Fabric mod (live) |
|---|---|---|---|
| Mods required | **none** | **none** (sidecar process owns the socket) | Fabric Loader + Fabric API |
| Live control | ❌ fixed rollout, chosen at cast time | ✅ your movement drives the model | ✅ your movement drives the model |
| Input source | `--skill` flag only | player pose polled over RCON (movement/look; no keyboard state) | server-observed per-tick pose delta |
| Display | solid-block wall (datapack playback) | solid-block wall (`setblock`/`fill` over RCON) | item-frame map wall (per-tick pixel resend) |
| Honest fps | pre-rendered playback at the datapack tick rate | **~2 fps** (every command is an RCON round-trip) | up to ~20 fps (map packets, not setblocks) |
| Requirements | any vanilla 1.21.x world; ml venv + checkpoint + ffmpeg | the throwaway server below + WM server + Node | JDK 21 build, 1.21.x Fabric server |

## Offline cast (datapack)

One command rolls the skill-conditioned world model, encodes the dream, and emits a
**vanilla Java datapack** that plays the animation on a block wall — no server-side
anything, works in singleplayer:

```bash
bash scripts/cast.sh                            # walk, 24 steps → /tmp/blockdream-cast/blockdream.zip
bash scripts/cast.sh --skill elytra --steps 48  # any of the 9 movement skills
```

It preflights the venv / ffmpeg / the `runs/skills_real` checkpoint and tells you exactly
what's missing. The product is a single **`blockdream.zip`** — a normal datapack, droppable
into **any vanilla Java 1.21.x world** (zipped datapacks are first-class; no unzipping needed):

1. `cp /tmp/blockdream-cast/blockdream.zip "<your world save>/datapacks/"`
2. In-game: `/reload`
3. `/function blockdream:setup` — one-time scoreboards + force-load + frame 0
4. `/function blockdream:start` (and `…:stop` to pause)

No world handy? `bash scripts/vanilla-server.sh --datapack /tmp/blockdream-cast/blockdream.zip`
boots a disposable localhost server with the pack pre-installed (see below).

## Live bridge (RCON)

The no-mod **live** path: a sidecar process polls a *stock vanilla server* over RCON,
so the server runs zero custom code. Three commands in three terminals:

```bash
# 1. throwaway vanilla 1.21.1 server (flat world, localhost-only, RCON enabled)
bash scripts/vanilla-server.sh          # prints the RCON password ONCE — copy it

# 2. the world-model server (serves runs/skills_real on ws://127.0.0.1:8765)
bash ml/scripts/serve_demo.sh

# 3. the bridge sidecar (Node, from the repo root)
npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pass>   # add --mock-wm to test without step 2
```

Join `localhost` with a Minecraft Java 1.21.1 client and move around: the wall of blocks
near spawn repaints with the model's predicted frames, steered by *your* movement.

**How it works** (core logic in [`../packages/cli/src/rcon-bridge.ts`](../packages/cli/src/rcon-bridge.ts),
all unit-testable without a game): the sidecar polls your pose via RCON
`data get entity <name> Pos` / `Rotation`, derives the world-model action from the pose
delta (the same `deriveAction` contract the Fabric mod and `serve.py` share), sends it
over WebSocket to the WM server, then paints each returned frame as a vertical
solid-block wall — quantize to the solid-block palette, delta against the previous
frame, greedy `fill`-merge, and send the commands back over RCON.

**Honest expectations:** every single command is an RCON round-trip, so the wall updates
at **roughly 2 fps** with a capped per-frame command budget (overflow cells carry into the
next frame). It's a genuinely live, genuinely mod-free demo — not the smooth-video path.
The wall is painted at a **fixed origin near spawn in the disposable flat world** the
script creates; the sidecar assumes that world, not your own save. RCON also cannot see
keyboard state, so sprint/jump are *inferred* from speed and vertical motion, and sneaking
is never detected.

## Security notes

`scripts/vanilla-server.sh` makes deliberately scoped trade-offs — understand them:

- **`online-mode=false`** — the server skips Mojang authentication, so *anyone who can
  reach the port can join under any name*. This exists so you can test instantly without
  auth round-trips, and it is only acceptable because of the next point.
- **Localhost binding** — `server-ip=127.0.0.1` binds both the game port *and* RCON
  (`127.0.0.1:25575`) to loopback; nothing off your machine can reach either. Do **not**
  change or blank `server-ip` while on a shared network.
- **Random RCON password** — generated per-setup (16 hex chars from `/dev/urandom`),
  printed once and stored in `.vanilla-server/server.properties` (a gitignored dir).
  RCON has full operator power, so treat the password like a root credential.
- **Trusted machines only** — RCON traffic is plaintext and the bridge runs with full
  command access. Run this stack only on a machine you trust end-to-end; never port-forward
  the RCON or game port.
- The Minecraft **EULA** is accepted on your behalf (loudly announced before it happens);
  the Mojang server jar is downloaded sha1-verified from Mojang's own manifest into a
  gitignored dir — never committed or redistributed.

## Fabric alternative

Want smooth video instead of a ~2 fps block wall? The optional
[Fabric mod](../mods/java-fabric/README.md) swaps each map's 16384-byte colour array
per tick — real video on an item-frame map wall, with the same live WM control.
The helper script does the JDK 21 preflight, builds the jar, and prints the manual
install steps:

```bash
bash scripts/fabric-install.sh              # build + install instructions
bash scripts/fabric-install.sh --build-only # just the jar
```

Full live architecture (shared by the mod and the RCON sidecar):
[`live-control.md`](./live-control.md).
