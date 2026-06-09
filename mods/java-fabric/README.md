# blockdream Map Wall — Fabric mod (Java 1.21.x)

The **high-FPS** block-art playback path. Instead of thousands of `setblock`s per
frame (the vanilla datapack path), this swaps each filled map's 16384-byte color
array per tick and lets the server resend the map packet — cheap enough for real
video on a wall of item-frame maps.

## Status
**Code complete; builds locally.** Compiled with the pinned Gradle 8.10 wrapper on
JDK 21 — Fabric Loom for Minecraft 1.21.1 requires that *Gradle itself* runs on
Java 21, so point `JAVA_HOME` at a real JDK 21:

```bash
# requires JDK 21 + internet (Fabric Loom pulls Minecraft + mappings)
cd mods/java-fabric
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew -q build
# → build/libs/blockdream-mapwall-<ver>.jar
```

> macOS + Homebrew note: `openjdk@21` is keg-only and invisible to `java_home`
> until registered once (no sudo needed):
> `ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk ~/Library/Java/JavaVirtualMachines/openjdk-21.jdk`

Drop the jar + Fabric API into a 1.21.x server's `mods/`.

**Remaining operator-gated step:** a live end-to-end run against a real Minecraft
1.21.x client + server with `serve.py` up — walk around in-game and watch the
model's frames stream onto the map wall. Everything up to that point (input
derivation, action schema, frame→map-colour, the jar build) is verified headless.

## Wiring a wall
1. Render a frame pool with the CLI:
   `blockdream render clip.gif --target mwframes --grid 256x128 --out world/blockdream/`
   (emits `frames.bin` + `maps.txt` — the map-id ↔ tile binding).
2. Build the item-frame wall and hold each listed map once so its `MapState` exists.
3. The mod auto-loads `frames.bin` on server start and animates the wall.

## Live world-model control (capstone)

Drop `<world>/blockdream/live.json` and the mod switches from static playback to **live**:
it connects to the neural world-model server, derives an action from the controlling
player's movement (stock vanilla client — no client mod), and streams the model's predicted
frames onto the map wall. A player walks around; the model's dream renders in front of them.

```json
{ "url": "ws://127.0.0.1:8765", "cols": 4, "rows": 2, "skill": "walk" }
```

Full architecture + setup: [`../../docs/live-control.md`](../../docs/live-control.md). The
data pipeline (input derivation, action schema, frame→map-colour) is unit-tested headless in
`packages/cli/test/control-sim.test.ts`.

### Bridge resilience (auto-reconnect)
If the world-model server dies or restarts, the bridge does **not** freeze the wall
forever: `WorldModelClient` reconnects automatically with exponential backoff
(1s → 2s → 4s … capped at 30s), resetting to 1s once a connection succeeds. Attempts
run on a dedicated daemon thread (java-websocket forbids reconnecting from its own
read thread), an intentional server-stop shuts the loop down cleanly, and every state
transition is logged. The mod also surfaces transitions in-game: the controlling
player gets an action-bar message when the bridge goes down or comes back, and each
reconnect sends a fresh `{"type":"reset"}` so the model starts a clean rollout.

## Layout
- `FramePool.java` — reader for the CLI's `frames.bin` (magic `MWMW`, keyframe tiles).
- `MapWallRenderer.java` — per-tick color-array swap + `markDirty()` resend (static **and** live).
- `BlockdreamMod.java` — Fabric entrypoint; auto-selects static (`frames.bin`) or live (`live.json`).
- `WorldModelClient.java` — WebSocket bridge to `serve.py`; decodes frames → map-colour tiles; auto-reconnects with capped exponential backoff.
- `InputCapture.java` — server-side pose-delta → VPT action (JVM twin of `control-sim.ts`).
- `MapColorMatcher.java` — nearest map colour from the bundled 244-colour palette resource.

> Mapping names (`MapState`, `MapIdComponent`, `WorldSavePath`) target 1.21.x Yarn;
> adjust if you retarget another version. Live mode bundles `org.java-websocket` via Loom `include`.
