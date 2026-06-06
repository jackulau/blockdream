"""Benchmark world-model inference paths and report which reach >=30 fps generation.

The served Minecraft model is autoregressive: a frame = n tokens decoded SEQUENTIALLY, so its
fps falls ~1/n. The browser lineage is few-step latent diffusion: the whole frame's latent is
denoised in K passes that are PARALLEL over space — fps barely depends on resolution. This
script measures both at served-ish scale (and AR at a coarser token grid) so the >=30 fps path
is concrete, not asserted.

  python scripts/bench_inference.py            # default sweep
  python scripts/bench_inference.py --quick    # tiny/fast (CI)

Real deployment is faster still: server GPU, or WebGPU in-browser via the exported ONNX
(transition.onnx + decoder.onnx, see export_onnx.py + ml/web/rollout.js). CPU here is a floor.
"""

from __future__ import annotations

import argparse
import time

import torch

from mineworld_wm.config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.actions import ActionEncoder
from mineworld_wm.transition_ar import ARTransition
from mineworld_wm.transition_diffusion import LatentDiffusionTransition
from mineworld_wm.serve import WorldModelSession


def _session(kind: str, image: int, downsample: int, dim: int, depth: int, steps: int) -> WorldModelSession:
    torch.manual_seed(0)
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=image, base_channels=24, latent_channels=4,
                                    downsample=downsample, vq_codebook_size=256 if kind == "ar" else 0)
    cfg.action = ActionConfig(embed_dim=dim)
    cfg.dynamics = DynamicsConfig(kind=kind, dim=dim, depth=depth, heads=4, diffusion_steps=steps)
    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n = cfg.latent_size**2
    if kind == "ar":
        trans = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=256, action_dim=dim)
    else:
        trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=4, action_dim=dim)
    return WorldModelSession(cfg, tok, enc, trans), n


@torch.no_grad()
def _bench(session: WorldModelSession, steps: int = 10) -> float:
    buttons, camera = torch.zeros(9), torch.tensor([0.2, -0.1])
    session.reset()
    session.step(buttons, camera)  # warmup
    t0 = time.perf_counter()
    for _ in range(steps):
        session.step(buttons, camera)
    return (time.perf_counter() - t0) / steps * 1000.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="tiny/fast config for CI")
    args = ap.parse_args()
    dim, depth = (64, 2) if args.quick else (192, 4)
    img = 32 if args.quick else 64

    rows = []
    # AR at the served 16x16=256-token grid (downsample → 16) and a coarser 8x8=64-token grid
    s, n = _session("ar", img, img // 16, dim, depth, 0)
    rows.append(("AR (sequential)", f"{n} tok/frame", _bench(s)))
    s, n = _session("ar", img, img // 8, dim, depth, 0)
    rows.append(("AR (coarse grid)", f"{n} tok/frame", _bench(s)))
    # diffusion few-step (parallel over space) at 8 and 4 steps
    s, _ = _session("diffusion", img, img // 16, dim, depth, 8)
    rows.append(("diffusion 8-step", "parallel/space", _bench(s)))
    s, _ = _session("diffusion", img, img // 16, dim, depth, 4)
    rows.append(("diffusion 4-step", "parallel/space", _bench(s)))

    print(f"\n  inference benchmark (CPU{'/quick' if args.quick else ''}, dim={dim} depth={depth} img={img})")
    print(f"  {'path':20s} {'shape':16s} {'ms/step':>9s} {'fps':>7s}  {'>=30?':>6s}")
    best = 0.0
    for name, shape, ms in rows:
        fps = 1000.0 / ms
        best = max(best, fps)
        print(f"  {name:20s} {shape:16s} {ms:9.1f} {fps:7.0f}  {'  ✓' if fps >= 30 else '  ✗':>6s}")
    fast = [r[0] for r in rows if 1000.0 / r[2] >= 30]
    print(f"\n  >=30 fps path(s): {', '.join(fast) if fast else 'NONE at this scale'}")
    print("  recommendation: serve via few-step diffusion (parallel over space; fps ~independent of")
    print("  resolution) — or coarsen the AR token grid. Browser WebGPU/ONNX is faster than this CPU floor.")
    return 0 if fast else 1


if __name__ == "__main__":
    raise SystemExit(main())
