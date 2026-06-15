# Driving world model - real comma.ai commaVQ, datasets, architecture, browser

A browser-playable, **recursive**, control-conditioned neural driving world model, runs
locally, fully open source. Built in `blockdream_wm.drive`.

> **The served model is 100% REAL (goal 029).** `runs/drive` is trained on comma.ai
> **commaVQ** - real dashcam VQ tokens (128/frame) + control/telemetry derived from comma's
> **real logged ego-motion** (`.pose.npy`), **zero synthesis**. It is **camera-only** (commaVQ has
> no LiDAR), served as a control-responsive token field (photoreal pixels need comma's VQ decoder,
> operator-gated). Reproduce it on any clone from the committed real fixture:
> `bash ml/scripts/setup_drive_real.sh` → `runs/drive` (CONTROLLABLE). Provenance is locked in
> `runs/drive/PROVENANCE.json` and enforced by `scripts/no_synthetic_guard.py`.
>
> **The physics SIM below (`drive/sim.py` / `collect.py` / `train_long.py`) is DEPRECATED - it
> synthesizes RGB + LiDAR + telemetry and is NOT served.** It is kept for research/repro only; the
> sim sections in this doc are historical. See `ml/CHECKPOINTS.md` for the real served model.

## Datasets found (verified June 2026)

Hard filter = has the **control actions** (steer/throttle/brake) most perception
datasets lack. Ranked for action-conditioned multimodal world-model training:

| Dataset | RGB | LiDAR | Telemetry | Control | Size | License | Download |
|---|---|---|---|---|---|---|---|
| **immanuelpeter/carla-autopilot-multimodal** ★ | 4-cam | 32-ch | ✓ | **full** | 362 GB | **MIT** | `huggingface-cli download immanuelpeter/carla-autopilot-multimodal-dataset --repo-type dataset` |
| OpenDILabCommunity/LMDrive | 4-cam | 64-ch | ✓ | + routes | 2.07 TB | CC-BY-NC | HF |
| nuScenes + **CAN bus expansion** | 6-cam | ✓ | ✓ | ✓ (expansion) | ~300 GB | NC, reg | nuscenes.org/download |
| commaai/comma2k19 (real) | 1-cam | ✗ | ✓ | steer+speed | ~100 GB | MIT | HF |
| **commaai/commavq** (real, tokenized) | tokens | ✗ | pose | ✗ | 20.6 GB | MIT | `huggingface-cli download commaai/commavq --repo-type dataset` |
| autonomousvision/PDM_Lite_Carla_LB2 | ✓ | ✓ | ~ | via pipeline | 309 GB | Apache-2.0 | HF |

Perception-only (no control, secondary): Waymo, KITTI-360, Argoverse 2, PandaSet, ONCE.

**Recommendation:** **carla-autopilot-multimodal** (MIT, exact RGB+LiDAR+telemetry+
control match) for scale-up; **commaVQ** (`drive/commavq.py` loader) as a tiny
real-driving in-browser testbed.

## Local good-physics generation (this repo) - DEPRECATED (synthetic, NOT served)

> Historical: this is the synthetic physics sim, replaced as the served model by real commaVQ
> (top of doc). Kept for research/repro only.

CARLA does **not** run on Apple Silicon (confirmed). So we ship a from-scratch
good-physics sim (`drive/sim.py`): **dynamic bicycle model + Pacejka magic-formula
tire** (`drive/physics.py`, drift-capable, kinematic-blend at low speed) on an oval
track, with **raycast LiDAR**, **ego-centric top-down RGB**, and **telemetry**.
`drive/collect.py` rolls out a pursuit autopilot → RGB + LiDAR + telemetry + control.

Scale-up sim (real engine, optional): **MetaDrive** (`metadriverse/metadrive`,
Apache-2.0) - the one Mac-native sim with RGB + LiDAR + telemetry + control +
Bullet physics at 1000+ FPS (install from GitHub `main` on Python 3.12/3.13).
highway-env (kinematic bicycle, pure-Python) is a fast deterministic fallback.

## Architecture (`drive/`)

drift-sim recipe - per-modality encoders → fused conditioning → recursive transition
→ per-modality decoder heads:
- **RGB** → VQ tokens (`Tokenizer`).
- **LiDAR** → MLP latent (`encoders.LidarCodec`).
- **control** (steer/throttle/brake) + prev LiDAR + prev telemetry → fused
  conditioning (`transition.DriveTransition._fuse`).
- **transition**: AR transformer over next RGB tokens conditioned on the fused
  vector, + `lidar_head` and `telemetry_head` regressing next LiDAR + telemetry.
- **recursive**: `DriveTransition.step` feeds its own output back (S_t + A_t → S_{t+1}).

Trained model **obeys physics** (steer-left → higher predicted yaw-rate than
steer-right) and stays stable over recursive rollout - verified in `test_drive_world`.

## Making it better - what changed

The model was trained on a single oval with single-step conditioning and only a summed
loss for "quality". Improvements:

- **Multi-track world** (`drive/sim.py make_track`): `oval, circle, wavy, peanut` - varied
  curvature (normal-offset corridors), so it learns more than one track. `collect.py` spans
  the shapes across rollouts.
- **Temporal context** (`DriveTransition(n_history=k)`): the transition optionally conditions
  on a window of the last *k* (control, telemetry) frames, so it sees momentum/lag instead of
  one step - single-step telemetry prediction drifts over long rollouts. Backward compatible
  (`n_history=0` = original).
- **Real evaluation** (`scripts/eval_drive.py`): per-modality validation error (RGB token
  accuracy, LiDAR MSE, telemetry MSE) **+ closed-loop drift** (roll the model forward feeding
  its own predictions back, compare the telemetry trajectory to the simulator). Measured:
  temporal context roughly **halves telemetry MSE** and reduces closed-loop drift vs
  single-step (`tests/test_eval_drive.py`).
- **Real-data path**: `drive/commavq.py` ingests comma's tokenized real driving video for
  scale-up beyond the synthetic sim (table above).
- **Served-checkpoint quality gate** (`scripts/eval_drive_quality.py`): unlike `eval_drive.py`
  (throwaway scratch models validating the recipe), this loads the REAL served checkpoint and
  gates it - per-modality one-step val error per track kind, plus closed-loop drift vs the
  wall-free physics ground truth (telemetry dynamics are position-independent, so a CarState
  reconstructed from the model's own init telemetry is an exact reference). `--quick` rides
  `scripts/verify-all.sh` (<3 s); thresholds are measured-value + headroom, pinned by pytest.
- **Production temporal context** (`train_long --n-history k`): the proven n_history
  conditioning is wired through training (real history windows + 15% history-dropout for the
  fresh-reset state, sliding window in the recursive rollout loss) and serving (`DriveSession`
  keeps the (control, telemetry) window; legacy checkpoints load unchanged). A 38-min M4 retrain
  improved closed-loop speed drift but regressed rgb CE / yaw drift / control margin, so the
  served checkpoint was kept (promote-only-if-better) - see `ml/CHECKPOINTS.md`.

```bash
python scripts/eval_drive.py            # per-modality + closed-loop drift, single vs temporal
python scripts/eval_drive_quality.py --checkpoint runs/drive/latest.pt --quick   # served-ckpt gate
```

Reference open models to deepen toward: **MUVO** (RGB+LiDAR+occupancy, open code+weights),
**Vista** (RGB action-conditioned, Apache-2.0), **OccWorld/Copilot4D** (LiDAR-as-tokens),
plus **Oasis/MineWorld** for stable real-time recursive rollout.

## Run it
```bash
# REAL served model (commaVQ) - reproduce from the committed real fixture, then serve:
bash ml/scripts/setup_drive_real.sh                                              # → runs/drive (CONTROLLABLE)
python -m blockdream_wm.drive.serve --checkpoint ml/runs/drive/latest.pt --port 8766
# open apps/web /driving.html → Connect → drive with arrows (camera token field + telemetry HUD;
# LiDAR BEV is n/a - commaVQ is camera-only). Scale up: stream more shards with
# scripts/collect_real_drive.py --stream-hf, train longer (operator-gated GPU).
```

## Browser (local, open)
Served via WebSocket today (RGB PNG + LiDAR + telemetry streamed, recursive). For a
true server-free in-browser engine: **ONNX Runtime Web + WebGPU**, keep the
transition transformer small + **q4/q8-quantized**, run in latent space and decode
RGB with a frozen VAE at low res, predict LiDAR as a low-res range latent visualized
as a BEV overlay (not per-frame 3D points). Oasis (~20 fps in-browser) is the proof.
