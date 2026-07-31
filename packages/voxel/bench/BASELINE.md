# Voxel builder benchmark snapshot

Deterministic disc input. `pnpm exec tsx packages/voxel/bench/voxel-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                      |   med (ms) |  M elem/s |
| -------------------------- | ---------: | --------: |
| imageToSolid               |     8.247 |     190.7 |
| imageToVolume(flat)        |     9.263 |     113.2 |
| imageToVolume(heightmap)   |     1.524 |     688.0 |
| volumeToFrame              |     2.509 |     626.9 |
| solidify(shell)            |    12.354 |      71.6 |
| forEachSolid               |     5.673 |     277.3 |
| spinSequence               |  1133.591 |      11.1 |

## A/B: optimized vs bounds-checked reference (same run - the rigorous comparison)

| stage            | ref (ms) | opt (ms) | speedup |
| ---------------- | -------: | -------: | ------: |
| column-fill      |     9.294 |     8.002 |    1.16x |
| full-scan-fill   |    10.343 |     2.482 |    4.17x |
| project-scan     |     7.547 |     1.970 |    3.83x |
| spinSequence     |  9852.320 |  1468.758 |    6.71x |
