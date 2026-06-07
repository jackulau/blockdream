# World models — full guide

Everything in `ml/`: the models, how to train / serve / run / evaluate each, the movement-type
conditioning, and the browser-native diffusion path. Run Python via `ml/.venv/bin/python`.
Checkpoints/data/runs are gitignored (local only).

## Models

| model | code | what it is | served from |
|---|---|---|---|
| **Minecraft AR** (primary) | `transition_ar.py` `ARTransition` | MineWorld-style: next-frame VQ tokens from `[action, prev tokens]`, autoregressive, KV-cached | `runs/m4/latest.pt` |
| **Skill-conditioned AR** | `movement.py` `SkillRealEncoder` + `train_long.py` | adds a per-movement-type embedding so the 9 movement types produce distinct dynamics | `runs/skills/latest.pt` |
| **Latent diffusion** (browser) | `transition_diffusion.py` `LatentDiffusionTransition` | rectified-flow over continuous VAE latents, few-step Euler — the >=30fps in-browser route | exported ONNX |
| **Driving** | `drive/transition.py` `DriveTransition` | multimodal driving world model (RGB + LiDAR + telemetry) | `runs/drive/latest.pt` |

All share the conv VQ/continuous **tokenizer** (`tokenizer.py`) and an **action encoder**
(`actions.py`; orientation-aware variant adds yaw/pitch/roll).

## Train

```bash
# Minecraft AR (real VPT pool), resumable, two-phase tokenizer→AR, time-boxed
.venv/bin/python -m blockdream_wm.train_long --pool data/pool_m4 --out runs/m4 \
    --preset m4 --device mps --ckpt-every-min 30 --max-minutes 480

# Skill-conditioned on all 9 movement types (see Movement types)
bash scripts/goal020_train_skills.sh

# Latent diffusion on real footage (for the browser engine)
.venv/bin/python scripts/train_diffusion.py --pool data/pool_m4 --out runs/diffusion \
    --size 64 --max-frames 8000 --max-minutes 40
```

Presets (`train_real.py PRESETS`): `quick` (downsample 4 → 256 tok @64px), `m4` (downsample 8 → 64
tok @128px, ~12M, fits 24 GB MPS), `full` (GPU). Every trainer resumes from `<out>/latest.pt` and
stops cleanly on `--max-minutes` or a `<out>/STOP` file.

## Serve

```bash
# Minecraft AR over WebSocket (CPU beats MPS for sequential token decode)
.venv/bin/python -m blockdream_wm.serve --real runs/m4/latest.pt --device cpu   # :8765
# Driving
.venv/bin/python -m blockdream_wm.drive.serve --checkpoint runs/drive/latest.pt # :8766
```

The web demo (`apps/web`, `pnpm --filter web dev`) auto-connects to both. Display is **decoupled**
from generation: a rAF loop redraws the latest frame every refresh (smooth display fps) while a
pump requests the next frame only when the previous arrives (true gen fps). Logging level via
`MINEWORLD_LOG=DEBUG` (per-step latency).

## Movement types

`movement.py` defines 9: `general, walk, sprint, jump, swim, boat, elytra, pig, minecart`. The VPT
contractor data is walking/general only, so the other skills need their own gradient. Two paths:

- **Synthetic, fast, provable:** `scripts/gen_movement_data.py` writes per-skill pools with
  distinct learnable dynamics (colour cast + scroll speed + bob) in the real on-disk format;
  `goal020_train_skills.sh` trains one skill-conditioned model on all 9.
- **Verify it works:** `scripts/verify_movement_types.py --checkpoint runs/skills/latest.pt` rolls
  every type out from the same seed and asserts the rollouts diverge (the embedding actually steers
  the world). Real per-skill footage drops into the same pool layout to scale up.

## Real data (Mineflayer) — the comma.ai path

The synthetic per-skill pools (above) *prove* the conditioning mechanism but don't look like real
Minecraft. For photoreal-and-conditioned dynamics, collect **real** per-movement-type footage the
way comma trains on fleet driving: `tools/mineflayer-collector/collect.mjs` drives a Mineflayer bot
through each movement type on a real server and records its first-person view (mp4 via
`prismarine-viewer` headless) plus, every physics tick, the **action** and **physics telemetry**
(position, velocity, yaw/pitch, on-ground, in-water, speed). `scripts/import_mineflayer.py` aligns
frames with the action+physics logs into `data/pool_real_<skill>/` (the trainer's pool format +
`physics.npy`). Then `train_long --pools data/pool_real_*` learns real per-skill dynamics, and
`physics.npy` is there for a physics-conditioned multimodal variant (like the driving model's
RGB+LiDAR+telemetry stack). Operator-gated (needs a server); the importer's resampling core is unit
tested (`tests/test_import_mineflayer.py`). See `tools/mineflayer-collector/README.md`.

## Browser diffusion

The server-free, in-browser engine (`ml/web/rollout.js`, onnxruntime-web). Pipeline:

```bash
# 1. train (above) → runs/diffusion/latest.pt
# 2. export the trained transition + decoder to ONNX (REAL weights via --checkpoint)
.venv/bin/python -m blockdream_wm.export_onnx --checkpoint runs/diffusion/latest.pt \
    --out ../apps/web/public/onnx
# 3. verify the export runs few-step Euler + decodes a valid frame at real-time fps
.venv/bin/python scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx
```

The browser runs the few-step Euler loop in JS, calling `transition.onnx` K times then
`decoder.onnx` once per frame. Because the whole frame's latent is denoised in parallel (not
token-by-token), the frame rate is roughly resolution-independent — this is the >=30fps route,
unlike the AR path whose fps falls ~1/N with token count.
