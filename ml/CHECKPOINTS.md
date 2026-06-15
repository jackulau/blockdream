# Checkpoint provenance manifest

All of `ml/runs/`, `ml/data/`, and `apps/web/public/onnx/` are **gitignored** (`.gitignore:13,15,39`) -
nothing below ships in git. This manifest is the tracked record of what each artifact is, how it was
gated, and how to regenerate it. Run everything from `ml/` with `.venv/bin/python`.

All "gate (2026-06-09)" rows below were **re-run fresh on 2026-06-09** against the exact files being
served (two WM servers + vite were live and CPU-busy during the runs). Live-serving claims were
confirmed the same day via `lsof`/`ps`: port 8765 = `blockdream_wm.serve --real …/runs/skills_real/latest.pt`,
port 8766 = `blockdream_wm.drive.serve --checkpoint …/runs/drive/latest.pt`, port 5173 = vite.
Historical claims are cited to `.claude-workspace/goals/021-movement-driving-wm-quality/GOAL.md`
("021 GOAL.md") and `docs/world-models-guide.md`, plus the per-run `log.csv` / `runs/*.log` files.

## LIVE (served)

| artifact | serves | what it is | gate (2026-06-09) | regen |
|---|---|---|---|---|
| `runs/skills_real/latest.pt` (28.4 MB, = `best.pt`, 2026-06-08) | `ws://127.0.0.1:8765` (Minecraft WM) | Skill-conditioned Minecraft AR world model - all **9 movement types on genuine real footage** (walk/general/sprint/jump = button-labeled real VPT via `scripts/extract_real_from_vpt.py`; swim/boat/elytra/pig/minecart = real mineflayer-rendered footage via `tools/mineflayer-collector` + `scripts/import_mineflayer.py`). 64px `quick` preset, MPS. **Provenance locked** by `runs/skills_real/PROVENANCE.json` (`synthetic:false`, 9 `pool_real_*`), enforced by `scripts/no_synthetic_guard.py`. The served weights are the all-real run's output - behavioral fingerprint `0.1104/36-36` matches the all-real training log and does NOT match the deleted synth-mixed attempt (`0.1520/33-36`); goal-029 independently reproduced the all-real pipeline (`runs/skills_real_fresh`, `0.0602/36-36`). | `.venv/bin/python scripts/verify_movement_types.py --checkpoint runs/skills_real/latest.pt` → `mean pairwise |Δframe| = 0.1104 · 36/36 pairs distinct` → **`DISTINCT`**, exit 0 | Build pools (`extract_real_from_vpt.py`, mineflayer collector + `import_mineflayer.py`, `prep_real_skill_pools.py`), then `OUT=runs/skills_real bash scripts/train_skills_hi.sh` (the script's `POOLS` now lists the 9 all-real pools) |
| `runs/drive/latest.pt` (10.4 MB, **real commaVQ**, goal-029 2026-06-14) | `ws://127.0.0.1:8766` (driving WM) | **100% REAL** driving world model - trained on comma.ai **commaVQ** footage (real dashcam VQ tokens, 128/frame, codebook 1024) with control + telemetry derived from comma's **real logged ego motion** (`.pose.npy` = forward velocity + yaw rate); **zero synthesis**. Camera-only (commaVQ has no LiDAR); served as a control-responsive **token field** (photoreal pixels need comma's VQ decoder, operator-gated). Telemetry **bounded** (`scale·tanh` head) + forward-speed floored ≥0 (physical, camera path). **Provenance locked** by `runs/drive/PROVENANCE.json` (`synthetic:false`, `data_source:commavq-real`), enforced by `scripts/no_synthetic_guard.py`. Replaces the **deprecated** physics-sim model (`drive.sim/collect/train_long`, NOT served; backup `runs/drive/pre029_sim_backup.pt`). | `.venv/bin/python scripts/eval_drive_control.py` (default `runs/drive/latest.pt`) → coast 0.00 → throttle 15.67 m/s (responds), yaw left +0.303 > right −0.289 (responds), speed physical → **`CONTROLLABLE`**, exit 0. **Quality (real branch)**: `eval_drive_quality.py --checkpoint runs/drive/latest.pt --quick` → real-holdout next-token CE 2.27 nats (random 6.93) / telemetry MSE 0.0005, controllable + free-run stable → **`QUALITY_OK`**, exit 0 (verify-all stanza) | **Tiny (proof, in-repo):** `.venv/bin/python scripts/collect_real_drive.py --stream-hf --max-segments 8 --out data/drive_real_pool` (or build from `tests/fixtures/commavq_real`), then `PROMOTE=1 OUT=runs/drive_real bash scripts/train_drive_real.sh`. **Full-scale (operator-gated, GPU):** stream many more commaVQ shards (`--shard data-00NN.tar.gz`), train longer, then promote + re-gate. |
| `apps/web/public/onnx/` (`transition.onnx` 6.4 MB + `decoder.onnx` 0.9 MB, exported 2026-06-06) | in-browser diffusion path (`ml/web/rollout.js`, onnxruntime-web; no server) | ONNX export of the latent rectified-flow diffusion WM (`runs/diffusion/latest.pt`, trained 2026-06-06: 14k trans steps on `pool_m4`, see `runs/diffusion/log.csv`). Few-step Euler in JS → the ≥30fps route. | `.venv/bin/python scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx --steps 8` → `frame (1, 3, 64, 64) ok · pixel spread 0.511 · 35.2 gen-fps` → **`PASS`**, exit 0 | `scripts/train_diffusion.py --pool data/pool_m4 --out runs/diffusion --size 64 --max-frames 8000 --max-minutes 40`, then `python -m blockdream_wm.export_onnx --checkpoint runs/diffusion/latest.pt --out ../apps/web/public/onnx` |

Notes on the gates: the drive control gate asserts MARGINS (throttle > coast + 1 m/s; left yaw >
right + 0.03; speed ∈ [0,60]), not absolute numbers, so it is robust to run-to-run drift. The
movement gate's mean |Δ| = **0.1104** matches the recorded value exactly.

`bash ml/scripts/serve_demo.sh` launches all of the above with the correct checkpoints (MC →
`runs/skills_real`, drive → `runs/drive`, web on 5173).

### Both world models are 100% REAL (goal-029)

There is **zero synthetic data** in any served/live world-model path, enforced mechanically by
`scripts/no_synthetic_guard.py` (a verify-all stanza):

- **Minecraft WM** (`runs/skills_real`) - real OpenAI VPT footage (walk/general/sprint/jump) + real
  mineflayer gameplay footage (swim/boat/elytra/pig/minecart). All 9 movement types DISTINCT.
- **Driving WM** (`runs/drive`) - real comma.ai **commaVQ** dashcam footage. commaVQ ships
  pre-tokenized real video (`X.token.npy`, 128 VQ tokens/frame) + comma's **real logged ego motion**
  (`X.pose.npy` = `[v_fwd, v_lat, v_up, ω_roll, ω_pitch, ω_yaw]`). `drive.commavq.commavq_control_telemetry`
  reads forward speed (col 0) + yaw rate (col 5) straight off the log → aligned control/telemetry,
  **no synthesis, no physics sim**. Camera-only: commaVQ has no LiDAR, so the real model is
  `n_lidar=0` and the served frame is a control-responsive token field (photoreal pixels need comma's
  VQ decoder, operator-gated). `collect_real_drive.py --stream-hf` pulls a few real segments straight
  from the HF shard (early-aborts after N - a few MB, not the 516 MB shard); a tiny real fixture is
  committed at `tests/fixtures/commavq_real/` for offline reproducibility.

The previous driving model was a 100% **synthetic physics sim** (`drive.sim` / `drive.collect` /
`drive.train_long`). Those modules are now **DEPRECATED, NOT served** (kept for research; the guard
asserts the served checkpoint is the real one). The sim checkpoint is preserved at
`runs/drive/pre029_sim_backup.pt`.

### Minecraft WM visual fidelity (goal-031)

The served Minecraft WM rendered blurry/washed frames ("does not look like Minecraft"). Root cause
(investigated, not guessed): the served checkpoint had **ar_step=1350** - `train_skills_hi.sh` requested
`--ar-steps 16000` under `--max-minutes 22`, so the tokenizer phase (6000 steps) ate the budget and the
AR phase was **wall-clock truncated to ~1350/16000 steps** -> it predicted averaged/blurry frames. The
tokenizer recon (faithful but soft), per-skill rollout std (healthy 0.14-0.30, no collapse), and the
serve frame->PNG path were all verified fine; the fix is TRAINING, not a pipeline bug.

Fixes:
- `train_skills_hi.sh`: `MAX_MIN` default 22 -> 90 (+ `AR_STEPS`/`TOK_STEPS`/`PRESET` overridable) so the
  AR phase runs to completion by default - the truncation cannot silently recur.
- `eval_mc_fidelity.py`: a fidelity gate (`detail_ratio` = rollout gradient energy / real-holdout energy)
  so "looks like Minecraft" is mechanically measured, not eyeballed. Floor-gates on gray collapse.
- Retrained the AR to completion on the real pools (resuming the trained tokenizer); promote-only-if-better
  vs the served checkpoint on fidelity AND 9/9 movement-type distinctness. A stronger 64px tokenizer
  (`hi64` preset: codebook 512->1024, base 48->64) is available to raise the recon sharpness ceiling.
- `serve_demo.sh` restart picks up the promoted checkpoint. (Numbers recorded at promote time.)

### More real footage + 128px (goal-033)

Follow-up after a user reported the demo still gray. Two findings:
1. **The live serve path is correct** - a WS round-trip (serve.py -> frame_to_png_b64) and an actual
   chrome-devtools browser shot of `serve_demo` both render RECOGNIZABLE Minecraft (blue sky, green
   terrain, horizon, hotbar) on the promoted 0.735 model. A flat-gray demo is a **STALE server**:
   restart `ml/scripts/serve_demo.sh` to load a promoted checkpoint.
2. **The data, not the model, was the ceiling.** The skill pools used <1% of pool_m4's 82,500 real
   128px VPT frames, downsampled to 64px. `prep_real_skill_pools.py` + `extract_real_from_vpt.py` gained
   a `--size 128` path; rebuilt walk/general (~12k frames each), jump (7k), sprint (1.1k) at native 128px;
   mineflayer skills (swim/boat/elytra/pig/minecart) upscaled real-64->128 (new in-game collection is
   operator-gated: needs Java 21 + a live server). `train_skills_hi.sh POOLS` is overridable; a 128px
   retrain (`PRESET=m4`, codebook 1024) on the 9 bigger pools is promote-only-if-better vs 0.735.
   Tradeoff: 128px gen is slower (~1.5 fps vs 3.8) but the display is rAF-decoupled, so it stays smooth.
   (Final promoted numbers recorded at promote time.)

### Temporal-context retrain experiment (2026-06-10, goal 027 - NOT promoted; sim-era, superseded)

`runs/drive_v3/` (`best.pt`, n_history=3, 58k AR steps / 38 min MPS) wired the proven temporal-context
conditioning into production (`train_long --n-history`, sliding history in `rollout_loss`, history
buffer in `DriveSession`; legacy checkpoints load unchanged). Head-to-head vs the served checkpoint
(`eval_drive_quality --quick` + `eval_drive_control`): closed-loop **speed** drift improved
(3.39 vs 4.32 m/s) and lidar MSE improved (0.0039 vs 0.0058), but rgb CE regressed (1.86 vs 1.32),
yaw drift regressed (0.290 vs 0.158), and the throttle-vs-coast control margin thinned (1.09 vs
2.75 m/s - one flaky run from the gate's 1.0 threshold). Promote-only-if-better → **kept the served
checkpoint**; `pre_goal027_backup.pt` (= the served file) preserved in `runs/drive/`. The n_history
plumbing ships for a future longer retrain.

## DEAD / ORPHAN (kept on disk, not served)

| artifact | what it is / why not served | source |
|---|---|---|
| `runs/m4/` (`latest.pt` 155 MB, `tokens.pt`, `samples/`; trained 2026-06-05→06, 73,358 AR steps / ~7.75 h MPS, `preset m4` 128px ~12M params) | Real-VPT **walking-only** base AR model. Skill embeddings are **DEAD** - `verify_movement_types.py` → 0/36 pairs distinct, every movement type renders identical. **Never serve.** Kept: it is the real-texture source (`pool_m4`) the served models' pools derive from. Regen: `python -m blockdream_wm.train_long --pool data/pool_m4 --out runs/m4 --preset m4 --device mps` (or `scripts/train_m4_multiday.sh`). | 021 GOAL.md root cause; `runs/m4/log.csv` |
| `runs/skills/` - **DELETED by goal-029** (synthetic-only, never served) | Was a synthetic-pools-only skill proof: 29/36 distinct, mean |Δ| 0.0223, decoded to **gray mush** (no real texture). Removed so zero synthetic-trained artifacts remain on disk. Regenerable from the now-DEPRECATED `scripts/goal020_train_skills.sh` if the conditioning proof is ever needed. | 021 GOAL.md D3/D5 log; goal-029 |
| `runs/skills_hi/` (`latest.pt` 28.4 MB; 2026-06-07) | Real walk/general (pool_m4↓64) + synthetic exotic blend: 36/36 distinct, mean |Δ| 0.0381, real-looking decode (021 D5 gate). **Superseded by `runs/skills_real`** (all-real footage, 0.1104). Historical regen path was `scripts/train_skills_hi.sh` with the real+synthetic pool mix; note the committed script's `POOLS` has since moved to all-real pools, so re-running it today reproduces a skills_real-class model, not this blend. | 021 GOAL.md D5; `runs/skills_hi.log` |
| `runs/skills_real_old/` - **DELETED by goal-029** (synthetic-contaminated backup, never served) | Was the **prior** skills_real lineage: first trained on real-VPT + synthetic exotic pools, then resumed onto the real mineflayer pools. Replaced by the fresh 2026-06-08 all-real retrain (`runs/skills_real_v2`, renamed into place - this is the served `runs/skills_real`, fingerprint `0.1104/36-36`). The old backup mixed synthetic exotic data, so goal-029 removed it. The served weights' all-real provenance is now locked in `runs/skills_real/PROVENANCE.json` and independently reproduced (`runs/skills_real_fresh`). The contradictory early lineage log was renamed `runs/skills_real.SUPERSEDED-synth-attempt.log`. | goal-022/023 memory notes; goal-029 provenance lock |
| `runs/drive_v2/` (`best.pt`, `latest.pt`, `tokens.pt`; 2026-06-07, 16k AR steps / 2k tok steps, ~6 min MPS) | The D2 retrain workspace. **Its `best.pt` was promoted to `runs/drive/latest.pt`** (021 GOAL.md [15:21]; verified 2026-06-09 by md5: `drive/latest.pt` ≡ `drive_v2/best.pt` = `1dfd34bd…`). What remains orphaned is `drive_v2/latest.pt` - the final 16k-step state (md5 `52e408d5…`), which scored worse than the best-by-val snapshot and is not served. The **pre-D2** drive checkpoint is preserved as `runs/drive/pre_d2_backup.pt` (≡ `runs/drive/best.pt`, md5 `f7d8309b…`). | 021 GOAL.md D2; md5 run 2026-06-09; `runs/drive_v2.log` |
| `runs/goal020/` | Logs only (`skills.log`, `drive.log`, `diffusion.log`) from the goal-020 training scripts. No checkpoints. | inventory 2026-06-09 |
| `runs/overnight/` | Logs only (`launch.out`, `overnight.log`) from `scripts/overnight_both.sh` orchestration. No checkpoints. | inventory 2026-06-09 |
| `runs/viewer/` | Serve logs only (`mc_serve.log`, `drive_serve.log`, `vite.log`). No checkpoints. | inventory 2026-06-09 |
| `runs/diffusion/` (`latest.pt` 23 MB, `latents.pt`; 2026-06-06) | Not dead - it is the **source checkpoint of the live ONNX export** above; just not served over WS itself. | `runs/diffusion/log.csv` |
| `runs/*.log` (top level) | Training stdout for the runs above (`drive_v2.log`, `skills_hi.log`, `skills_real{,2,3}.log`, `skills_real_v2.log`). | inventory 2026-06-09 |

## Deliberately-unmerged branches

- `goal/012-movement-control-fidelity` - roll/yaw/pitch + camera control + per-frame movement tags (5 commits). Deliberately unmerged: changes the action schema across serve.py / InputCapture.java / web and needs a data migration + retrain. Re-open as its own goal when ready.
- `goal/021-backup-pre-mlclean` - snapshot backup taken before an ml/ cleanup (2 commits); keep as a backup, never merge.
- `goal/013-insanely-good-demo`, `goal/020-3d-anim-video-worldmodels-rebrand`, `goal/021-every-version-blockart-playback`, `goal/021-movement-driving-wm-quality` - fully merged into the consolidated line (verified with `git branch --merged`); branches safe to delete.

## Distribution

- `runs/skills_real/latest.pt` ships as a GitHub release asset: https://github.com/jackulau/blockdream/releases/tag/v0.1.0 - fetch with `bash scripts/fetch-checkpoint.sh` (idempotent; `BLOCKDREAM_CKPT_DIR`/`BLOCKDREAM_RELEASE` overrides).
