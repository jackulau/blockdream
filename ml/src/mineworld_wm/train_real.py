"""Train our (MineWorld-style AR) world model on REAL prepared VPT data.

Consumes prepare_vpt's frames.npy + actions.npy, trains the tokenizer + AR
transition on the real (frame_t, action_t → frame_{t+1}) sequence, and saves a
checkpoint the tester serves (via serve.load_real_checkpoint).

Toy/CPU scale here (small data, few steps) → a real-but-weak model; `--full` and a
GPU scale it to quality. The pipeline is identical at any scale.

    python -m mineworld_wm.train_real --data ml/data/vpt_sample --steps 200 --out ml/checkpoints/vpt.pt
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from .config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from .tokenizer import Tokenizer
from .actions import ActionEncoder
from .transition_ar import ARTransition


def make_config(image_size: int) -> Config:
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=image_size, base_channels=48, latent_channels=6,
                                    downsample=4, vq_codebook_size=512)
    cfg.action = ActionConfig(embed_dim=64)
    cfg.dynamics = DynamicsConfig(kind="ar", dim=192, depth=4, heads=6)
    return cfg


def load_data(data_dir: str) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    d = Path(data_dir)
    frames = np.load(d / "frames.npy")  # (T, H, W, 3) uint8
    actions = np.load(d / "actions.npy")  # (T, 11) float
    x = torch.from_numpy(frames).float().permute(0, 3, 1, 2) / 255.0  # (T,3,H,W)
    buttons = torch.from_numpy(actions[:, :9]).float()
    camera = torch.from_numpy(actions[:, 9:]).float()
    return x, buttons, camera


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.train_real")
    ap.add_argument("--data", default="ml/data/vpt_sample")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--tok-steps", type=int, default=200)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--out", default="ml/checkpoints/vpt.pt")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    torch.manual_seed(args.seed)
    x, buttons, camera = load_data(args.data)
    T, _, H, _ = x.shape
    cfg = make_config(H)
    print(f"[train_real] {T} real VPT frames @ {H}px  ({int(buttons.sum())} button presses)")

    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n_tokens = cfg.latent_size**2
    ar = ARTransition(cfg.dynamics, n_tokens=n_tokens, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)

    # 1) tokenizer (minibatched — frames can be many)
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for step in range(args.tok_steps):
        idx = torch.randint(0, T, (min(args.batch, T),))
        out = tok(x[idx])
        topt.zero_grad()
        out.loss.backward()
        topt.step()
    with torch.no_grad():
        recon = torch.nn.functional.mse_loss(tok(x[: min(T, 32)]).recon, x[: min(T, 32)]).item()

    # 2) AR transition on consecutive frames
    with torch.no_grad():
        tokens = tok.tokenize(x).flatten(1)  # (T, n_tokens)
    prev_all, next_all = tokens[:-1], tokens[1:]
    btn_all, cam_all = buttons[:-1], camera[:-1]
    npairs = prev_all.shape[0]
    opt = torch.optim.Adam(list(ar.parameters()) + list(enc.parameters()), lr=2e-3)
    first = last = None
    for step in range(args.steps):
        idx = torch.randint(0, npairs, (min(args.batch, npairs),))
        action = enc(btn_all[idx], cam_all[idx])
        loss = ar.loss(prev_all[idx], next_all[idx], action)
        opt.zero_grad()
        loss.backward()
        opt.step()
        if first is None:
            first = loss.item()
        last = loss.item()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "config": cfg.to_dict(), "kind": "ar", "source": "vpt",
        "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": ar.state_dict(),
        "init_frame": x[0].clone(),
    }, out)
    print(f"[train_real] recon-mse {recon:.4f}  ar-loss {first:.3f}->{last:.3f}  → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
