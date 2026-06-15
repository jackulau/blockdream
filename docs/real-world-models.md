# Real Minecraft world models - landscape & our path

Verified June 2026 (HuggingFace API status + file manifests, not just model cards).

## Open Minecraft world models that exist

| Model | Repo | Status | Size | License | Hardware |
|---|---|---|---|---|---|
| **MineWorld** (Microsoft, our original namesake pre-rebrand) | `microsoft/mineworld` | ❌ **weights 401 / taken down** (May 2025, still down) - code only | - | MIT (code) | - |
| **Oasis-500m** (Etched/Decart) | `Etched/oasis-500m` | ✅ gated (1-click accept) | 3.35 GB | MIT | ~8–10 GB VRAM; CPU very slow |
| **Matrix-Game 1.0** (Skywork) | `Skywork/Matrix-Game` | ✅ public, highest fidelity | **87 GB** (17B) | MIT | A100/H100 only |
| **Lucid v1** | `ramimmo/lucidv1` | ✅ public, realtime on 4090 | 3.45 GB | CC-BY-NC (non-commercial) | RTX 4090 |
| **AMD Micro-World** | `amd/Micro-World-{I2W,T2W}` | ✅ public | 38 / 4.7 GB | OpenRAIL | ROCm-tuned |

Not Minecraft (ruled out): Matrix-Game **2.0/3.0** (GTA/TempleRun/Unreal), WHAM/Muse (Bleeding Edge), GameNGen (DOOM), DIAMOND (Atari/CS:GO), Genie-2 (closed).

## Decision: train our own (MineWorld-style) on real VPT data

The user asked to "use the Microsoft one." **Its weights are gone** - you cannot
download MineWorld. But:
1. Its **architecture is open** and **we already implement it** - `transition_ar.py`
   is a MineWorld-style VQ-tokens + autoregressive transition transformer.
2. Real **action-labeled Minecraft data is downloadable**: OpenAI **VPT**
   (`all_10xx_Jun_29.json` → 5661 contractor demos, each an mp4 + a per-frame
   action `.jsonl` with mouse dx/dy + keyboard keys + hotbar).

So we **train our own** on real VPT data, automatically. (Oasis-500m is the
fallback if you want a pretrained drop-in - it's the only downloadable one with a
documented action interface; integration would mirror `serve.load_real_checkpoint`.)

## The automatic pipeline (`ml/scripts/train_real.sh`)

```
fetch VPT (video + actions)  →  extract frames + map actions  →  train  →  checkpoint  →  serve
   prepare_vpt.py                  vpt_actions.py                train_real.py   serve --real
```

- `bash ml/scripts/train_real.sh --quick` - 1 segment, 64px, CPU, ~3 min → a
  real-but-blurry model (proven: recon-mse 0.0035; learns sky/grass/horizon).
- `bash ml/scripts/train_real.sh --full` - 20 segments, 128px, 4000 steps → run on
  a GPU for Minecraft-quality fidelity. Same code, scaled.
- Serve: `python -m blockdream_wm.serve --real ml/checkpoints/vpt.pt`, then drive it
  in the web tester (`/world-model.html`).

### VPT action format → our action space (`vpt_actions.py`)
- `keyboard.keys` (`key.keyboard.w/a/s/d/space/left.shift/left.control`) → buttons
  0–6 (fwd/back/left/right/jump/sneak/sprint)
- `mouse.buttons` (0=attack, 1=use) → buttons 7–8
- `mouse.dx, dy` (pixels) → camera, scaled by `CAMERA_DENOM=20` and clamped to ±1

### Alignment
VPT video + jsonl are 20 Hz. We sample frames at `--fps` (stride `20/fps`) and take
each sampled frame's action from the matching jsonl line; training pairs are
`(frame_t tokens, action_t) → frame_{t+1} tokens`.

## Training on an Apple Silicon Mac (M4 Pro, MPS) - measured

The trainer auto-detects **MPS** (Apple GPU). Benchmarked on an **M4 Pro / 24 GB**:

| config | params | tokens/frame | throughput | fits 24 GB? |
|---|---|---|---|---|
| 64px (256 tok) | 2M | 256 | 144 frames/s | yes |
| **128px @ ds8 (256 tok) - `--preset m4`** | 12M | 256 | **52 frames/s (~3 steps/s)** | yes |
| 96px (576 tok) | 12M | 576 | 14 frames/s | tight |
| 128px @ ds4 (1024 tok) | 12M | 1024 | - | **OOM** |
| 256px (4096 tok) | 100M | 4096 | - | **OOM** |

MPS is **~5–6× faster than CPU** here. The 24 GB cap matters: our AR builds a
~2·tokens-length attention sequence, so **keep tokens ≈256** (the `m4` preset uses
128px at downsample-8). Bigger (256px / 100M+) needs an M4 Max (more unified RAM)
or a cloud GPU.

### One command
```bash
bash ml/scripts/train_real.sh --m4 [segments] [steps]
# e.g. an overnight run for a recognizable, drivable model:
bash ml/scripts/train_real.sh --m4 80 80000
```
**Rough M4 Pro wall-clock** (at ~3 AR steps/s):

| Result | Data | Steps | Time (prep + train) |
|---|---|---|---|
| quick/rough drivable | ~15 min footage (30 seg) | ~30k | **~3–5 hrs** |
| recognizable + drivable | ~40 min footage (80 seg) | ~80k | **~overnight (8–14 hrs)** |

(data prep = ~172 MB/segment download + ffmpeg extract; tokenizer trains first,
then the AR transition - the AR steps dominate). Serve when done:
`python -m blockdream_wm.serve --real ml/checkpoints/vpt.pt`.

### Multi-day run (hardened, hourly checkpoints)
For a long, days-long run use the production trainer (`train_long.py`) via:
```bash
bash ml/scripts/train_m4_multiday.sh [segments]   # default 100 (~50 min footage, ~16 GB)
```
It is built for unattended multi-day training:
- **Resumable** - re-run the same command (or it auto-restarts on crash) and it
  continues exactly from `ml/runs/m4/latest.pt` (model + optimizer + step + phase).
- **Hourly checkpoints** (`--ckpt-every-min 60`), atomic writes (a crash mid-save
  can't corrupt the checkpoint).
- **Cached, resumable data pool** - a stopped download skips already-fetched
  segments; pool is per-segment `seg_*.npz` (no all-in-RAM load).
- **Progress you can watch** - `ml/runs/m4/log.csv` (train + val loss) and
  `ml/runs/m4/samples/*.png` (real frame on top, the model's reconstruction below -
  watch it sharpen).
- **Two-phase** - tokenizer first (40k steps), tokens cached, then AR ~forever.
- Stop gracefully any time: `touch ml/runs/m4/STOP` (saves a final checkpoint).

Run it under `nohup`/`tmux` (or just leave the terminal open). More `segments` =
more data = sharper (bounded by the 24 GB / 128px ceiling). Note this `m4` run is
real-VPT walking-only - its skill embeddings are dead, so don't serve it for the
demo; serve the skill-conditioned real-footage checkpoint instead:
`python -m blockdream_wm.serve --real ml/runs/skills_real/latest.pt` (or just run
`bash ml/scripts/serve_demo.sh`, which picks the correct checkpoints).

## Honest limits
- CPU-only here → small data + few steps → blurry. The pipeline is real and
  automatic; **fidelity scales with data + GPU** (`--full`).
- MineWorld weights are not coming back; if you want a strong pretrained model
  *today*, accept the Oasis-500m license and wire it like the real checkpoint
  loader (its 25-dim action vector maps from our buttons/camera the same way).
