# Voxel builder benchmark snapshot

Deterministic disc input. `pnpm exec tsx packages/voxel/bench/voxel-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                      |   med (ms) |  M elem/s |
| -------------------------- | ---------: | --------: |
| imageToSolid               |     2.763 |     569.3 |
| imageToVolume(flat)        |     2.446 |     428.6 |
| imageToVolume(heightmap)   |     0.685 |    1529.9 |
| volumeToFrame              |     0.921 |    1707.5 |
| solidify(shell)            |     3.442 |     257.1 |
| forEachSolid               |     1.953 |     805.4 |

## A/B: optimized vs bounds-checked reference (same run - the rigorous comparison)

| stage            | ref (ms) | opt (ms) | speedup |
| ---------------- | -------: | -------: | ------: |
| column-fill      |     2.493 |     2.262 |    1.10x |
| full-scan-fill   |     3.837 |     0.872 |    4.40x |
| project-scan     |     2.716 |     1.091 |    2.49x |
