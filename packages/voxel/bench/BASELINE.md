# Voxel builder benchmark snapshot

Deterministic disc input. `pnpm exec tsx packages/voxel/bench/voxel-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                      |   med (ms) |  M elem/s |
| -------------------------- | ---------: | --------: |
| imageToSolid               |     8.705 |     180.7 |
| imageToVolume(flat)        |     3.203 |     327.3 |
| imageToVolume(heightmap)   |     1.481 |     707.9 |
| volumeToFrame              |     2.210 |     711.6 |
| solidify(shell)            |     2.643 |     334.8 |
| forEachSolid               |     2.116 |     743.3 |
| spinSequence               |   166.351 |      75.6 |

## A/B: optimized vs bounds-checked reference (same run - the rigorous comparison)

| stage            | ref (ms) | opt (ms) | speedup |
| ---------------- | -------: | -------: | ------: |
| column-fill      |     3.006 |     2.961 |    1.02x |
| full-scan-fill   |    13.955 |     1.262 |   11.06x |
| project-scan     |     2.860 |     1.423 |    2.01x |
| spinSequence     |  1735.976 |   107.816 |   16.10x |
| spinSequence-inner |   145.212 |   130.141 |    1.12x |
