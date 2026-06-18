# Voxel builder benchmark baseline

Deterministic disc input. Median of timed runs (`pnpm exec tsx packages/voxel/bench/voxel-bench.ts`).
Numbers are machine-dependent; what matters is the **before/after delta on the same machine**.

| stage                      |   med (ms) |  M elem/s |
| -------------------------- | ---------: | --------: |
| imageToSolid               |     3.441 |     457.0 |
| imageToVolume(flat)        |     3.472 |     302.0 |
| imageToVolume(heightmap)   |     0.970 |    1080.8 |
| volumeToFrame              |     3.246 |     484.5 |
| solidify(shell)            |     8.962 |      98.7 |
| forEachSolid               |     2.373 |     662.7 |
