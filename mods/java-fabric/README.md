# mineworld Map Wall — Fabric mod (Java 1.21.x)

The **high-FPS** block-art playback path. Instead of thousands of `setblock`s per
frame (the vanilla datapack path), this swaps each filled map's 16384-byte color
array per tick and lets the server resend the map packet — cheap enough for real
video on a wall of item-frame maps.

## Status
**Code complete; operator-build.** This module is NOT compiled in the mineworld
CI sandbox (no JDK 21 there). Build it yourself:

```bash
# requires JDK 21 + internet (Fabric Loom pulls Minecraft + mappings)
cd mods/java-fabric
./gradlew build            # → build/libs/mineworld-mapwall-<ver>.jar
```

Drop the jar + Fabric API into a 1.21.x server's `mods/`.

## Wiring a wall
1. Render a frame pool with the CLI:
   `mineworld render clip.gif --target mwframes --grid 256x128 --out world/mineworld/`
   (emits `frames.bin` + `maps.txt` — the map-id ↔ tile binding).
2. Build the item-frame wall and hold each listed map once so its `MapState` exists.
3. The mod auto-loads `frames.bin` on server start and animates the wall.

## Layout
- `FramePool.java` — reader for the CLI's `frames.bin` (magic `MWMW`, keyframe tiles).
- `MapWallRenderer.java` — per-tick color-array swap + `markDirty()` resend.
- `MineworldMod.java` — Fabric entrypoint wiring the server-tick callback.

> Mapping names (`MapState`, `MapIdComponent`, `WorldSavePath`) target 1.21.x Yarn;
> adjust if you retarget another version.
