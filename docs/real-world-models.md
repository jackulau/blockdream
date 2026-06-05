# Real Minecraft world models — landscape & our path

Verified June 2026 (HuggingFace API status + file manifests, not just model cards).

## Open Minecraft world models that exist

| Model | Repo | Status | Size | License | Hardware |
|---|---|---|---|---|---|
| **MineWorld** (Microsoft, our namesake) | `microsoft/mineworld` | ❌ **weights 401 / taken down** (May 2025, still down) — code only | — | MIT (code) | — |
| **Oasis-500m** (Etched/Decart) | `Etched/oasis-500m` | ✅ gated (1-click accept) | 3.35 GB | MIT | ~8–10 GB VRAM; CPU very slow |
| **Matrix-Game 1.0** (Skywork) | `Skywork/Matrix-Game` | ✅ public, highest fidelity | **87 GB** (17B) | MIT | A100/H100 only |
| **Lucid v1** | `ramimmo/lucidv1` | ✅ public, realtime on 4090 | 3.45 GB | CC-BY-NC (non-commercial) | RTX 4090 |
| **AMD Micro-World** | `amd/Micro-World-{I2W,T2W}` | ✅ public | 38 / 4.7 GB | OpenRAIL | ROCm-tuned |

Not Minecraft (ruled out): Matrix-Game **2.0/3.0** (GTA/TempleRun/Unreal), WHAM/Muse (Bleeding Edge), GameNGen (DOOM), DIAMOND (Atari/CS:GO), Genie-2 (closed).

## Decision: train our own (MineWorld-style) on real VPT data

The user asked to "use the Microsoft one." **Its weights are gone** — you cannot
download MineWorld. But:
1. Its **architecture is open** and **we already implement it** — `transition_ar.py`
   is a MineWorld-style VQ-tokens + autoregressive transition transformer.
2. Real **action-labeled Minecraft data is downloadable**: OpenAI **VPT**
   (`all_10xx_Jun_29.json` → 5661 contractor demos, each an mp4 + a per-frame
   action `.jsonl` with mouse dx/dy + keyboard keys + hotbar).

So we **train our own** on real VPT data, automatically. (Oasis-500m is the
fallback if you want a pretrained drop-in — it's the only downloadable one with a
documented action interface; integration would mirror `serve.load_real_checkpoint`.)

## The automatic pipeline (`ml/scripts/train_real.sh`)

```
fetch VPT (video + actions)  →  extract frames + map actions  →  train  →  checkpoint  →  serve
   prepare_vpt.py                  vpt_actions.py                train_real.py   serve --real
```

- `bash ml/scripts/train_real.sh --quick` — 1 segment, 64px, CPU, ~3 min → a
  real-but-blurry model (proven: recon-mse 0.0035; learns sky/grass/horizon).
- `bash ml/scripts/train_real.sh --full` — 20 segments, 128px, 4000 steps → run on
  a GPU for Minecraft-quality fidelity. Same code, scaled.
- Serve: `python -m mineworld_wm.serve --real ml/checkpoints/vpt.pt`, then drive it
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

## Honest limits
- CPU-only here → small data + few steps → blurry. The pipeline is real and
  automatic; **fidelity scales with data + GPU** (`--full`).
- MineWorld weights are not coming back; if you want a strong pretrained model
  *today*, accept the Oasis-500m license and wire it like the real checkpoint
  loader (its 25-dim action vector maps from our buttons/camera the same way).
