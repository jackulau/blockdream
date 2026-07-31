# Emit-commands benchmark snapshot

Deterministic seeded inputs. `pnpm exec tsx packages/emit-commands/bench/emit-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                              |   med (ms) |  M elem/s |
| ---------------------------------- | ---------: | --------: |
| rgbScreenDeltaLines                |     6.169 |      47.8 |
| generateRgbScreenDatapack          |    29.240 |      10.1 |
| generateRgbScreenDatapackReference |    95.502 |       3.1 |
| greedyBoxes                        |     5.989 |      21.0 |
| computeVoxelDeltas                 |     0.787 |     561.9 |
| noteSequencer(playsound)           |     0.313 |       1.9 |
| redstoneSequencer                  |     0.356 |       1.7 |

## A/B: optimized vs retained byte-identical reference (same run - the rigorous comparison)

| stage                  | ref (ms) | opt (ms) | speedup |
| ---------------------- | -------: | -------: | ------: |
| rgbscreen-delta-lines  |     8.745 |     5.280 |    1.66x |
| greedy-boxes           |   629.633 |    18.060 |   34.86x |
