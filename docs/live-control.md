# Live world-model control from inside Minecraft

**The capstone demo:** a player joins a Minecraft server, walks around, and the *neural
world model's* predicted world streams onto a wall of in-game maps in front of them - at
map-resend speed, not setblock speed. The player's own movement is the model's control input.

This high-FPS map-wall version is **Java-only** and needs the bundled Fabric mod
(`mods/java-fabric`). The technical constraint is real: pure-vanilla command blocks cannot
open a socket or paint map pixels, there is no client-side input capture without mods, and
Bedrock can do none of it natively (see the bottom of this page). But there **is** a shipped
no-mod live path: the **RCON sidecar** ([`packages/cli/src/rcon-bridge.ts`](../packages/cli/src/rcon-bridge.ts))
runs *outside* the game, polls a stock vanilla server's player pose over RCON, and paints
the model's frames as a solid-block wall - genuinely live at **~2 fps** (every block is an
RCON round-trip). Setup: [`play-without-fabric.md`](./play-without-fabric.md). The data
pipeline is proven headless in
[`packages/cli/src/control-sim.ts`](../packages/cli/src/control-sim.ts) +
`control-sim.test.ts` - no JVM/client needed to verify the contract.

## Architecture

```
 ┌─────────────┐   movement/look    ┌──────────────┐  action JSON   ┌────────────────────┐
 │  Player      │  (server-observed) │ InputCapture │ ─────────────► │ world-model server │
 │ vanilla MC   │ ─────────────────► │ (server tick)│  ws://…:8765   │  serve.py (Python) │
 │  client      │                    └──────────────┘                └─────────┬──────────┘
 │              │ ◄───────────────────────────────────────────────────────────┘
 └─────────────┘     map-wall packets        ┌──────────────────┐   frame (PNG)
        ▲   the wall of maps updates ◄─────── │ WorldModelClient │ ◄─ decode → nearest map
        └─────────────────────────────────────│  + MapWallRenderer│    colour → MapState.colors
                                              └──────────────────┘
```

- **InputCapture** (`InputCapture.java`) derives a VPT action - 9 buttons + 2-axis camera -
  from the player's per-tick pose delta. Forward/back/strafe come from the movement vector
  projected into the facing frame; jump/sneak/sprint from entity flags; camera from the
  yaw/pitch delta. **No client mod, no keyboard hook** - a stock client just needs to join.
  (JVM twin of the unit-tested `deriveAction`.)
- **WorldModelClient** (`WorldModelClient.java`) is a WebSocket client to `serve.py`. It
  sends `{"type":"action","buttons":[…],"camera":[…],"skill":"walk"}` and receives
  `{"type":"frame","png_b64":…}`. It PNG-decodes the frame, scales it to the wall, matches
  every pixel to the nearest map colour (`MapColorMatcher`, same 244-colour table as the rest
  of the toolchain), and hands per-tile 16384-byte arrays to the renderer.
- **MapWallRenderer** (live mode) copies the latest streamed frame into each map's
  `MapState.colors` every tick and `markDirty()`s it - the high-FPS resend path.

## Operator setup (Java)

> No Fabric? Follow [`play-without-fabric.md`](./play-without-fabric.md) instead - the
> RCON sidecar needs only steps like these plus a stock vanilla server (`scripts/vanilla-server.sh`).

1. **Run the world-model server** (from `ml/`):
   ```bash
   python -m blockdream_wm.serve --real runs/skills_real/latest.pt   # ws://127.0.0.1:8765
   ```
   Serve `runs/skills_real` (skill-conditioned, trained on genuine per-skill footage - all 9
   movement types distinct), **not** `runs/m4`: m4 is real-VPT walking-only, so its
   skill embeddings are dead and every movement type renders identically. For the whole browser demo
   run `ml/scripts/serve_demo.sh` - it starts the MC + driving servers + web with the right checkpoints.
2. **Build + install the mod** (JDK 21):
   ```bash
   cd mods/java-fabric && ./gradlew build      # → build/libs/*.jar
   ```
   Drop the jar in the server's `mods/` (Fabric loader + Fabric API required). The
   Java-WebSocket dependency is bundled (`include`), so the jar is self-contained.
3. **Build the map wall** in-world: place a grid of item frames (cols×rows), fill them with
   maps, and list those map ids row-major in `<world>/blockdream/maps.txt` (one per tile). The
   `blockdream` CLI's `mwframes` target emits a `maps.txt` template.
4. **Enable live mode**: drop `<world>/blockdream/live.json`:
   ```json
   { "url": "ws://127.0.0.1:8765", "cols": 4, "rows": 2, "skill": "walk", "actionEveryTicks": 1 }
   ```
5. **Join and move.** Your walking/looking drives the model; its dream streams onto the wall.
   Switch `skill` to `boat`, `elytra`, etc. to change the movement regime (requires a
   skill-conditioned checkpoint - see goal 019).

If `live.json` is absent the mod falls back to **static** `frames.bin` playback
([`load-into-minecraft.md`](./load-into-minecraft.md) / [`fps-budget.md`](./fps-budget.md)).

## Why not pure vanilla, and why not Bedrock-native

In-game vanilla mechanisms (command blocks / datapacks) still cannot do live control -
nothing inside the game can open a socket. The loophole is to move the socket *outside*
the game: the RCON sidecar talks to a stock server over the vanilla RCON protocol, so
"vanilla + sidecar" gets real live control, just slowly (setblock walls, not map packets):

| Capability | Vanilla datapack | Vanilla + RCON sidecar | Java + Fabric mod | Bedrock |
|---|---|---|---|---|
| Open a socket to the model server | ❌ | ✅ (sidecar process owns it) | ✅ | ❌ (no outbound socket in stable Script API) |
| Read per-tick player input as control | ⚠️ scoreboard-only, coarse | ⚠️ pose polling (~2 Hz; sprint/jump inferred, no keyboard) | ✅ (server pose delta) | ⚠️ Script API, limited |
| Paint arbitrary pixels fast (map resend) | ❌ | ❌ (`setblock`/`fill` wall, command-budgeted) | ✅ (`MapState.colors`) | ❌ (no map-pixel API) |
| **Live model control onto a screen** | ❌ | ✅ at ~2 fps ([`play-without-fabric.md`](./play-without-fabric.md)) | ✅ high-FPS | ❌ natively |

**Bedrock path:** the only way to get this on a Bedrock *client* is to join the Java server
through **GeyserMC** (a Bedrock-protocol proxy). The Bedrock player then sees the Java map
wall and their movement is captured server-side exactly as above - the mod is unchanged.
Bedrock-native (behavior pack / Script API) cannot do it: no socket, no map pixels.

## What's verified here vs operator-gated

- **Verified in CI (no game):** action derivation from pose deltas, the action-message schema
  (matches `serve.py`), and frame→map-colour-tiles - all in `control-sim.test.ts` (13 tests),
  driving the same transforms the Java classes implement.
- **Operator-gated:** building the jar (needs JDK 21 + Fabric toolchain) and running it against
  a live 1.21 client + the Python server. The repo has no JDK/MC sandbox, so the mod is
  code-complete and contract-tested, not CI-compiled (see `mods/java-fabric/README.md`).
