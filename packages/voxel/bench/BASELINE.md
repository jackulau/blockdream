# Voxel builder benchmark snapshot

Deterministic disc input. `pnpm exec tsx packages/voxel/bench/voxel-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                      |   med (ms) |  M elem/s |
| -------------------------- | ---------: | --------: |
| imageToSolid               |     6.724 |     233.9 |
| imageToVolume(flat)        |    11.941 |      87.8 |
| imageToVolume(heightmap)   |     0.887 |    1182.7 |
| volumeToFrame              |     1.124 |    1399.7 |
| solidify(shell)            |     2.612 |     338.7 |
| forEachSolid               |     2.259 |     696.2 |
| spinSequence               |   223.958 |      56.2 |

## A/B: optimized vs bounds-checked reference (same run - the rigorous comparison)

| stage            | ref (ms) | opt (ms) | speedup |
| ---------------- | -------: | -------: | ------: |
| column-fill      |     8.430 |     8.859 |    0.95x |
| full-scan-fill   |     7.780 |     2.138 |    3.64x |
| project-scan     |     9.289 |     1.763 |    5.27x |
| spinSequence     |  2389.342 |   203.579 |   11.74x |
