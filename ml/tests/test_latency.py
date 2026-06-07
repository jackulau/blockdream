"""Inference latency: the few-step diffusion path must be cheap (the browser
lineage targets ~30fps). These are CPU/toy timings — real deployment uses WebGPU
(browser) or a server GPU — but they prove the few-step path is far cheaper than
the autoregressive path and comfortably real-time at this scale."""

from __future__ import annotations

import time

import torch

from blockdream_wm.config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.actions import ActionEncoder
from blockdream_wm.transition_ar import ARTransition
from blockdream_wm.transition_diffusion import LatentDiffusionTransition
from blockdream_wm.serve import WorldModelSession


def _session(kind: str) -> WorldModelSession:
    torch.manual_seed(0)
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4,
                                    vq_codebook_size=64 if kind == "ar" else 0)
    cfg.action = ActionConfig(embed_dim=32)
    cfg.dynamics = DynamicsConfig(kind=kind, dim=64 if kind == "ar" else 32, depth=2, heads=4, diffusion_steps=8)
    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n = cfg.latent_size**2
    if kind == "ar":
        trans = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)
    else:
        trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim)
    return WorldModelSession(cfg, tok, enc, trans)


def _bench(session: WorldModelSession, steps: int = 12) -> float:
    buttons = torch.zeros(9)
    camera = torch.tensor([0.2, -0.1])
    session.reset()
    session.step(buttons, camera)  # warmup
    t0 = time.perf_counter()
    for _ in range(steps):
        session.step(buttons, camera)
    return (time.perf_counter() - t0) / steps * 1000.0  # ms/step


@torch.no_grad()
def test_diffusion_step_is_realtime_and_faster_than_ar():
    diff_ms = _bench(_session("diffusion"))
    ar_ms = _bench(_session("ar"))
    print(f"\n[latency] diffusion {diff_ms:.2f} ms/step ({1000/diff_ms:.0f} fps)  "
          f"AR {ar_ms:.2f} ms/step ({1000/ar_ms:.0f} fps)  [CPU/toy — browser uses WebGPU]")
    # few-step diffusion path is comfortably under a real-time frame budget even on CPU
    assert diff_ms < 50.0, f"diffusion step too slow: {diff_ms:.2f} ms"
    # the few-step diffusion path is the browser lineage precisely because it beats AR
    assert diff_ms < ar_ms, f"diffusion ({diff_ms:.2f}) not faster than AR ({ar_ms:.2f})"
