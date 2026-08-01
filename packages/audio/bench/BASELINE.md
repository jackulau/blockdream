# Audio pitch-detection benchmark snapshot

Deterministic PCM. `pnpm exec tsx packages/audio/bench/pitch-bench.ts`.

## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)

| stage                    |   med (ms) | windows/s |
| ------------------------ | ---------: | --------: |
| detectPitchHz(voiced)    |   178.314 |       550 |
| detectPitchHz(transient) |     0.075 |    279222 |
| detectPitchHz(rms-gated) |     0.076 |    627796 |
| analyzeAudio(voiced)     |    74.720 |       535 |

## A/B: optimized vs verbatim reference twin (same run - the rigorous comparison)

| stage            | ref (ms) | opt (ms) | speedup |
| ---------------- | -------: | -------: | ------: |
| voiced-sweep     |   244.590 |   246.062 |    0.99x |
| transient-clicks |    40.644 |     0.077 |  528.42x |
