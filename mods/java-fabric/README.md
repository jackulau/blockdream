# blockdream Map Wall — Fabric mod (Java 1.21.x)

The **high-FPS** block-art playback path. Instead of thousands of `setblock`s per
frame (the vanilla datapack path), this swaps each filled map's 16384-byte color
array per tick and lets the server resend the map packet — cheap enough for real
video on a wall of item-frame maps.

## Status
**Code complete; operator-build.** This module is NOT compiled in the blockdream
CI sandbox (no JDK 21 there). Build it yourself:

```bash
# requires JDK 21 + internet (Fabric Loom pulls Minecraft + mappings)
cd mods/java-fabric
./gradlew build            # → build/libs/blockdream-mapwall-<ver>.jar
```

Drop the jar + Fabric API into a 1.21.x server's `mods/`.

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

## Layout
- `FramePool.java` — reader for the CLI's `frames.bin` (magic `MWMW`, keyframe tiles).
- `MapWallRenderer.java` — per-tick color-array swap + `markDirty()` resend (static **and** live).
- `BlockdreamMod.java` — Fabric entrypoint; auto-selects static (`frames.bin`) or live (`live.json`).
- `WorldModelClient.java` — WebSocket bridge to `serve.py`; decodes frames → map-colour tiles.
- `InputCapture.java` — server-side pose-delta → VPT action (JVM twin of `control-sim.ts`).
- `MapColorMatcher.java` — nearest map colour from the bundled 244-colour palette resource.

> Mapping names (`MapState`, `MapIdComponent`, `WorldSavePath`) target 1.21.x Yarn;
> adjust if you retarget another version. Live mode bundles `org.java-websocket` via Loom `include`.
