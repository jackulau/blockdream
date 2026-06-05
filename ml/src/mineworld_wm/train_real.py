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
from .device import pick_device, device_name


# presets balance resolution vs token count (attention is O((2·tokens)²) — the
# 24GB M4 Pro caps tokens ~256, so the m4 preset uses downsample 8 at 128px).
PRESETS = {
    # name:      (downsample, base, latent, codebook, dim, depth, heads)
    "quick": (4, 48, 6, 512, 192, 4, 6),    # tiny, any device
    "m4": (8, 64, 8, 1024, 384, 6, 8),       # 128px → 256 tok, fits 24GB MPS (~12M)
    "full": (4, 96, 8, 8192, 768, 12, 12),   # GPU, big (256px → 4096 tok, ~100M)
}


def make_config(image_size: int, preset: str = "quick") -> Config:
    ds, base, latc, cb, dim, depth, heads = PRESETS[preset]
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=image_size, base_channels=base, latent_channels=latc,
                                    downsample=ds, vq_codebook_size=cb)
    cfg.action = ActionConfig(embed_dim=64)
    cfg.dynamics = DynamicsConfig(kind="ar", dim=dim, depth=depth, heads=heads)
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
    ap.add_argument("--device", default="auto", help="auto | mps | cuda | cpu")
    ap.add_argument("--preset", default="quick", choices=list(PRESETS), help="quick | m4 | full")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    torch.manual_seed(args.seed)
    dev = pick_device(args.device)
    x, buttons, camera = load_data(args.data)
    x, buttons, camera = x.to(dev), buttons.to(dev), camera.to(dev)
    T, _, H, _ = x.shape
    cfg = make_config(H, args.preset)
    print(f"[train_real] {T} real VPT frames @ {H}px  ({int(buttons.sum())} presses)  device={device_name(dev)}")

    tok = Tokenizer(cfg.tokenizer).to(dev)
    enc = ActionEncoder(cfg.action).to(dev)
    n_tokens = cfg.latent_size**2
    ar = ARTransition(cfg.dynamics, n_tokens=n_tokens, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim).to(dev)

    # 1) tokenizer (minibatched — frames can be many)
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for step in range(args.tok_steps):
        idx = torch.randint(0, T, (min(args.batch, T),), device=dev)
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
        idx = torch.randint(0, npairs, (min(args.batch, npairs),), device=dev)
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
    tok.cpu(); enc.cpu(); ar.cpu()  # save portable (CPU) state for serving anywhere
    torch.save({
        "config": cfg.to_dict(), "kind": "ar", "source": "vpt",
        "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": ar.state_dict(),
        "init_frame": x[0].detach().cpu().clone(),
    }, out)
    print(f"[train_real] recon-mse {recon:.4f}  ar-loss {first:.3f}->{last:.3f}  → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
