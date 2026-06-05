# Vanilla command-block playback — budgets

The vanilla path places one solid block per pixel and animates via delta-encoded
`.mcfunction` frames (see `@mineworld/emit-commands`). Two limits bound it:

## 1. Per-function command count
A single function running thousands of `setblock`s in one tick stresses
`maxCommandChainLength` (default 65536) and causes a frame hitch. The generators
split any frame whose `setblock` count exceeds `maxCommandsPerFunction`
(default **8000**) into `frames/<i>/part<k>` sub-functions called by the parent.

| Grid (W×H) | Keyframe setblocks | Functions at limit 8000 |
|---|---|---|
| 64×64 | 4,096 | 1 |
| 128×64 | 8,192 | 2 |
| 128×128 | 16,384 | 3 |
| 256×128 | 32,768 | 5 |

Keyframe (frame 0) is the worst case; delta frames are typically a small
fraction of this for real video (only changed cells).

## 2. Per-tick throughput
Playback advances one frame every `speedTicks` ticks (20 tps):

| speedTicks | fps |
|---|---|
| 1 | 20 |
| 2 | 10 |
| 4 | 5 |

The **sustained** cost is the *delta* size per advanced frame, not the keyframe.
A talking-head / low-motion clip at 64×64 changes a few hundred cells/frame →
trivially runs at 10 fps. High-motion full-frame change at 128×128 (16k setblocks
every advance) will hitch — prefer lower resolution, lower fps, or the modded
map-wall path (`@mineworld/emit-java`) for high-motion content.

## Rules of thumb
- **Low motion, hero quality** → vanilla blocks, 64–128 wide, 5–10 fps.
- **High motion / video** → map-item wall (modded/server path), which swaps a
  16384-byte array per map instead of thousands of block updates.
- Always `forceload` (Java) / `tickingarea` (Bedrock) the build area — included
  in generated `setup`.
