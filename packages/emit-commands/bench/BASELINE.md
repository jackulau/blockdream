# Emit-commands benchmark snapshot

Deterministic seeded inputs. `pnpm exec tsx packages/emit-commands/bench/emit-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                              |   med (ms) |  M elem/s |
| ---------------------------------- | ---------: | --------: |
| rgbScreenDeltaLines                |    13.961 |      21.1 |
| generateRgbScreenDatapack          |   355.775 |       0.8 |
| generateRgbScreenDatapackReference |   383.707 |       0.8 |
| greedyBoxes                        |   190.389 |       0.7 |
| computeVoxelDeltas                 |    10.258 |      43.1 |
| noteSequencer(playsound)           |     1.225 |       0.5 |
| redstoneSequencer                  |     1.937 |       0.3 |

## A/B: optimized vs retained byte-identical reference (same run - the rigorous comparison)

| stage                  | ref (ms) | opt (ms) | speedup |
| ---------------------- | -------: | -------: | ------: |
| rgbscreen-delta-lines  |    10.727 |     8.956 |    1.20x |
| greedy-boxes           |  2339.469 |   383.503 |    6.10x |
