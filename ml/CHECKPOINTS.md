# Checkpoint provenance manifest

All of `ml/runs/`, `ml/data/`, and `apps/web/public/onnx/` are **gitignored** (`.gitignore:13,15,39`) —
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
| `runs/skills_real/latest.pt` (28.4 MB, = `best.pt`, 2026-06-08) | `ws://127.0.0.1:8765` (Minecraft WM) | Skill-conditioned Minecraft AR world model — all **9 movement types on genuine real footage** (walk/general/sprint/jump = button-labeled real VPT via `scripts/extract_real_from_vpt.py`; swim/boat/elytra/pig/minecart = real mineflayer-rendered footage via `tools/mineflayer-collector` + `scripts/import_mineflayer.py`). 64px `quick` preset, MPS. | `.venv/bin/python scripts/verify_movement_types.py --checkpoint runs/skills_real/latest.pt` → `mean pairwise |Δframe| = 0.1104 · 36/36 pairs distinct` → **`DISTINCT`**, exit 0 | Build pools (`extract_real_from_vpt.py`, mineflayer collector + `import_mineflayer.py`, `prep_real_skill_pools.py`), then `OUT=runs/skills_real bash scripts/train_skills_hi.sh` (the script's `POOLS` now lists the 9 all-real pools) |
| `runs/drive/latest.pt` (12.7 MB, 2026-06-07) | `ws://127.0.0.1:8766` (driving WM) | Driving world model (RGB + LiDAR + telemetry). Telemetry **bounded** (per-channel `scale·tanh` head, 021 GOAL.md D1) and **controllable** under its own recursive rollout (K=12 scheduled-sampling rollout loss + speed-diverse data, 021 GOAL.md D2). | `.venv/bin/python scripts/eval_drive_control.py` (default ckpt is `runs/drive/latest.pt`) → coast 8.06 → throttle 10.81 m/s (responds), yaw left +0.479 > right −1.203 (responds), speed physical → **`CONTROLLABLE`**, exit 0 | `python -m blockdream_wm.drive.collect --rollouts 300 --steps 260 --out data/drive_pool`, then `python -m blockdream_wm.drive.train_long --pool data/drive_pool --out runs/drive_v2 --tok-steps 2000 --ar-steps 16000 --device mps`, promote `runs/drive_v2/best.pt → runs/drive/latest.pt`, re-gate with `eval_drive_control.py` |
| `apps/web/public/onnx/` (`transition.onnx` 6.4 MB + `decoder.onnx` 0.9 MB, exported 2026-06-06) | in-browser diffusion path (`ml/web/rollout.js`, onnxruntime-web; no server) | ONNX export of the latent rectified-flow diffusion WM (`runs/diffusion/latest.pt`, trained 2026-06-06: 14k trans steps on `pool_m4`, see `runs/diffusion/log.csv`). Few-step Euler in JS → the ≥30fps route. | `.venv/bin/python scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx --steps 8` → `frame (1, 3, 64, 64) ok · pixel spread 0.511 · 35.2 gen-fps` → **`PASS`**, exit 0 | `scripts/train_diffusion.py --pool data/pool_m4 --out runs/diffusion --size 64 --max-frames 8000 --max-minutes 40`, then `python -m blockdream_wm.export_onnx --checkpoint runs/diffusion/latest.pt --out ../apps/web/public/onnx` |

Notes on today's gate values vs the goal log: the drive gate's absolute numbers drift run-to-run
(021 GOAL.md recorded coast 7.3 → throttle 10.2; today 8.06 → 10.81) — the gate's margins
(throttle > coast + 1 m/s; left yaw > right + 0.03; speed ∈ [0,60]) are what is asserted, and both
runs pass them. The movement gate's mean |Δ| = **0.1104** matches the recorded value exactly.

`bash ml/scripts/serve_demo.sh` launches all of the above with the correct checkpoints (MC →
`runs/skills_real`, drive → `runs/drive`, web on 5173).

## DEAD / ORPHAN (kept on disk, not served)

| artifact | what it is / why not served | source |
|---|---|---|
| `runs/m4/` (`latest.pt` 155 MB, `tokens.pt`, `samples/`; trained 2026-06-05→06, 73,358 AR steps / ~7.75 h MPS, `preset m4` 128px ~12M params) | Real-VPT **walking-only** base AR model. Skill embeddings are **DEAD** — `verify_movement_types.py` → 0/36 pairs distinct, every movement type renders identical. **Never serve.** Kept: it is the real-texture source (`pool_m4`) the served models' pools derive from. Regen: `python -m blockdream_wm.train_long --pool data/pool_m4 --out runs/m4 --preset m4 --device mps` (or `scripts/train_m4_multiday.sh`). | 021 GOAL.md root cause; `runs/m4/log.csv` |
| `runs/skills/` (`latest.pt` 28.4 MB, `STOP`, `samples/`; 2026-06-06) | Synthetic-pools-only skill proof: 29/36 distinct, mean |Δ| 0.0223, but decodes to **gray mush** (no real texture). Superseded. Regen: `scripts/goal020_train_skills.sh`. | 021 GOAL.md D3/D5 log |
| `runs/skills_hi/` (`latest.pt` 28.4 MB; 2026-06-07) | Real walk/general (pool_m4↓64) + synthetic exotic blend: 36/36 distinct, mean |Δ| 0.0381, real-looking decode (021 D5 gate). **Superseded by `runs/skills_real`** (all-real footage, 0.1104). Historical regen path was `scripts/train_skills_hi.sh` with the real+synthetic pool mix; note the committed script's `POOLS` has since moved to all-real pools, so re-running it today reproduces a skills_real-class model, not this blend. | 021 GOAL.md D5; `runs/skills_hi.log` |
| `runs/skills_real_old/` (`latest.pt` 28.4 MB; 2026-06-07→08) | The **prior** skills_real lineage: first trained on real-VPT + synthetic exotic, then resumed twice onto the real mineflayer pools (AR steps 4542 → 6742 → 10115, `runs/skills_real{,2,3}.log` + its `log.csv`). Replaced by the fresh 2026-06-08 retrain (fresh tokenizer on genuine footage; trained as `runs/skills_real_v2`, see `runs/skills_real_v2.log`, then renamed into place). Kept as backup only. | `runs/skills_real*.log`, `runs/skills_real_old/log.csv`; goal-022/023 memory notes |
| `runs/drive_v2/` (`best.pt`, `latest.pt`, `tokens.pt`; 2026-06-07, 16k AR steps / 2k tok steps, ~6 min MPS) | The D2 retrain workspace. **Its `best.pt` was promoted to `runs/drive/latest.pt`** (021 GOAL.md [15:21]; verified 2026-06-09 by md5: `drive/latest.pt` ≡ `drive_v2/best.pt` = `1dfd34bd…`). What remains orphaned is `drive_v2/latest.pt` — the final 16k-step state (md5 `52e408d5…`), which scored worse than the best-by-val snapshot and is not served. The **pre-D2** drive checkpoint is preserved as `runs/drive/pre_d2_backup.pt` (≡ `runs/drive/best.pt`, md5 `f7d8309b…`). | 021 GOAL.md D2; md5 run 2026-06-09; `runs/drive_v2.log` |
| `runs/goal020/` | Logs only (`skills.log`, `drive.log`, `diffusion.log`) from the goal-020 training scripts. No checkpoints. | inventory 2026-06-09 |
| `runs/overnight/` | Logs only (`launch.out`, `overnight.log`) from `scripts/overnight_both.sh` orchestration. No checkpoints. | inventory 2026-06-09 |
| `runs/viewer/` | Serve logs only (`mc_serve.log`, `drive_serve.log`, `vite.log`). No checkpoints. | inventory 2026-06-09 |
| `runs/diffusion/` (`latest.pt` 23 MB, `latents.pt`; 2026-06-06) | Not dead — it is the **source checkpoint of the live ONNX export** above; just not served over WS itself. | `runs/diffusion/log.csv` |
| `runs/*.log` (top level) | Training stdout for the runs above (`drive_v2.log`, `skills_hi.log`, `skills_real{,2,3}.log`, `skills_real_v2.log`). | inventory 2026-06-09 |

## Deliberately-unmerged branches

- `goal/012-movement-control-fidelity` — roll/yaw/pitch + camera control + per-frame movement tags (5 commits). Deliberately unmerged: changes the action schema across serve.py / InputCapture.java / web and needs a data migration + retrain. Re-open as its own goal when ready.
- `goal/021-backup-pre-mlclean` — snapshot backup taken before an ml/ cleanup (2 commits); keep as a backup, never merge.
- `goal/013-insanely-good-demo`, `goal/020-3d-anim-video-worldmodels-rebrand`, `goal/021-every-version-blockart-playback`, `goal/021-movement-driving-wm-quality` — fully merged into the consolidated line (verified with `git branch --merged`); branches safe to delete.

## Distribution

- `runs/skills_real/latest.pt` ships as a GitHub release asset: https://github.com/jackulau/blockdream/releases/tag/v0.1.0 — fetch with `bash scripts/fetch-checkpoint.sh` (idempotent; `BLOCKDREAM_CKPT_DIR`/`BLOCKDREAM_RELEASE` overrides).
