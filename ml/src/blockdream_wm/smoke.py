"""Smoke test: prove the env is wired (torch + numpy + a forward/backward step)."""

from __future__ import annotations

import sys

import numpy as np
import torch
from torch import nn

from . import __version__
from .config import load_config


def main() -> int:
    cfg = load_config()
    torch.manual_seed(cfg.train.seed)

    # tiny end-to-end: random "latent" -> linear -> loss -> backward
    x = torch.randn(cfg.train.batch_size, cfg.tokenizer.latent_channels)
    net = nn.Sequential(nn.Linear(cfg.tokenizer.latent_channels, 16), nn.GELU(), nn.Linear(16, cfg.tokenizer.latent_channels))
    y = net(x)
    loss = ((y - x) ** 2).mean()
    loss.backward()
    grad_ok = all(p.grad is not None for p in net.parameters())

    print(f"blockdream_wm {__version__}")
    print(f"python {sys.version.split()[0]} | torch {torch.__version__} | numpy {np.__version__}")
    print(f"device {cfg.train.device} | latent_size {cfg.latent_size} | smoke loss {loss.item():.4f}")
    print(f"autograd ok: {grad_ok}")
    return 0 if grad_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
