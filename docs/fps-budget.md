# FPS budget - what runs at what frame rate, honestly

"30 fps" means different things in different parts of blockdream. This page is the honest
per-technique breakdown so nobody over-claims. Two separate worlds:

- **Browser demo** - the canvas the visitor sees. Display is locked smooth; *content* freshness
  depends on the model.
- **In-world (real Minecraft)** - physically bounded by command/packet throughput. This is where
  "30 fps full-screen" is simply not a thing in vanilla.

## Browser demo (`apps/web`)

| Surface | Display fps | Content (gen) fps | Notes |
|---|---|---|---|
| Minecraft world-model viewer | **refresh-locked, ≥30 (60–120)** | ~2 fps (256-token AR, ~450 ms CPU / ~1066 ms MPS) | Display is **decoupled** from generation (rAF redraw of the latest frame + a one-in-flight pump), so the canvas is smooth even though the model is slow. Raising *gen* to ≥30 needs the fast-inference path (goal 019). |
| Driving world-model viewer | refresh-locked, ≥30 | ~43 fps | Driving model is small/fast; gen already exceeds display. |
| 3D voxel viewer / GIF replay | refresh-locked, ≥30 | n/a | Playback honors the GIF's real per-frame durations (see `anim.ts`); turntable spin is delta-time scaled (refresh-rate independent). |

**"Locked smooth 30 fps" = the display never drops below refresh**, guaranteed by the decoupled
loop in `apps/web/src/viewer.ts` (asserted by `scripts/check-render-loop.mjs`, now wired into
`pnpm test`). We deliberately do **not** cap the display down to 30 - free-running at the monitor's
refresh is strictly smoother, and ≥30 is the floor, not the target. The HUD shows
`display fps · gen fps · latency ms` so the two rates are never conflated.

## In-world: Java Edition

| Technique | Resolution × fps (realistic) | Status | How |
|---|---|---|---|
| **Vanilla datapack block-swap** | 64–128 wide, **5–10 fps low-motion** | ✅ shipped + tested | `/setblock`+`/fill`, delta-encoded, **greedy box-merged** (a flat 64² region → 1 `/fill`, see `fill.ts greedyBoxes`). High-motion video blows the per-tick delta budget → drops frames. |
| **Map-wall (Fabric mod)** | 128px/map tiled, **target 10 fps; 20 fps after pre-cache** | ⚙️ mod code-complete, operator-build | Swap each map's 16384-byte `MapState.colors` + `markDirty()` → server resends the map packet. One array swap per map beats thousands of block updates. |
| **Display entities** | ≤64×64 @ 20 fps | ✋ designed, not built | `block_display` grid animated via `transformation` interpolation. Client-bound. |

**The map-wall's real constraint** isn't compute, it's map loading: Minecraft takes ~10 ticks to
load a *new* map id, so naive per-frame map creation runs ~2 fps. The fix is to **pre-cache the
whole frame pool** (all map ids loaded once) and then only swap colours on already-loaded maps -
that's what gets you to 10–20 fps. Bandwidth: a 4×4 wall @ 10 fps full-change ≈ 2.6 MB/s per
tracking player.

## In-world: Bedrock Edition

| Technique | Realistic | Status |
|---|---|---|
| Behavior-pack block-swap | low-motion only, ≤10 fps | ✅ shipped + tested |
| Script-API block-swap | smoother deltas, still update-bound | ✅ shipped + tested |
| Map-pixel video | **impossible natively** (no map-pixel API) | ❌ |
| High-fps video / live model control | **only via GeyserMC → Java** | see [`live-control.md`](./live-control.md) |

Bedrock has no map-pixel API and no outbound socket in the stable Script API, so neither
high-fps map video nor live world-model control is reachable Bedrock-native. A Bedrock client
gets both by joining the Java server through Geyser.

## Where "≥30 fps everywhere" actually lands

- **Browser display:** yes, today (≥ refresh, decoupled).
- **Browser Minecraft *content*:** the few-step **diffusion** path is the >=30 fps answer
  (parallel over space, fps ~independent of resolution) - `ml/scripts/bench_inference.py` measures
  ~47 fps for it even on a CPU floor vs ~4 fps for sequential 256-token AR (the current served
  model). Operator step: train + serve/export a diffusion MC checkpoint (the AR path is what's
  trained today). Driving content already clears 30.
- **In-world:** no, and not claimed - vanilla caps ~10 fps, the map-wall mod targets ~20 fps.
  30 fps full-screen in real Minecraft is not physically available; we render smooth in the
  browser and stream to the map wall at map-resend speed.
