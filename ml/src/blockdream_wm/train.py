"""Unified trainer: tokenizer + transition (AR or diffusion) on synthetic rollouts.

Toy/CPU scale. The real run swaps `make_rollouts` for VPT/MineRL data, scales the
configs, and runs on multi-GPU - the loop is the same.

    python -m blockdream_wm.train --config configs/toy.yaml --max-steps 50
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

from .config import load_config
from .tokenizer import Tokenizer
from .actions import ActionEncoder, mask_inactive_buttons
from .data import make_rollouts
from .transition_ar import ARTransition
from .transition_diffusion import LatentDiffusionTransition


def build(cfg):
    if cfg.dynamics.kind == "diffusion":
        cfg.tokenizer.vq_codebook_size = 0  # diffusion path uses continuous latents
    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n_tokens = cfg.latent_size**2
    if cfg.dynamics.kind == "ar":
        trans: torch.nn.Module = ARTransition(
            cfg.dynamics, n_tokens=n_tokens, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim
        )
    else:
        trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim)
    return tok, enc, trans


def make_dataset(cfg):
    rolls = make_rollouts(n=8, seq_len=8, size=cfg.tokenizer.image_size, n_buttons=cfg.action.n_buttons, seed=cfg.train.seed)
    frames = torch.cat([r.frames for r in rolls])  # (8*8, 3, H, W)
    return rolls, frames


def transition_loss(cfg, tok, enc, trans, rolls):
    total = torch.zeros(())
    for r in rolls:
        buttons = mask_inactive_buttons(r.buttons, cfg.demo.active_buttons)
        action = enc(buttons[:-1], r.camera[:-1])
        if cfg.dynamics.kind == "ar":
            with torch.no_grad():
                toks = tok.tokenize(r.frames).flatten(1)
            total = total + trans.loss(toks[:-1], toks[1:], action)
        else:
            with torch.no_grad():
                z = tok.encode(r.frames)
            total = total + trans.loss(z[1:], z[:-1], action)
    return total / len(rolls)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.train")
    ap.add_argument("--config", type=str, default=None)
    ap.add_argument("--max-steps", type=int, default=None)
    ap.add_argument("--kind", type=str, default=None, choices=["ar", "diffusion"])
    ap.add_argument("--demo", type=str, default=None)
    ap.add_argument("--out", type=str, default="checkpoints/toy.pt")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    if args.max_steps is not None:
        cfg.train.max_steps = args.max_steps
    if args.kind is not None:
        cfg.dynamics.kind = args.kind
    if args.demo is not None:
        cfg.demo.name = args.demo

    torch.manual_seed(cfg.train.seed)
    tok, enc, trans = build(cfg)
    rolls, frames = make_dataset(cfg)
    params = list(tok.parameters()) + list(enc.parameters()) + list(trans.parameters())
    opt = torch.optim.Adam(params, lr=cfg.train.lr)

    print(f"[train] kind={cfg.dynamics.kind} demo={cfg.demo.name} steps={cfg.train.max_steps} "
          f"params={sum(p.numel() for p in params)/1e3:.1f}k")

    first = None
    last = 0.0
    for step in range(cfg.train.max_steps):
        recon = tok(frames).loss
        trans_l = transition_loss(cfg, tok, enc, trans, rolls)
        total = recon + trans_l
        opt.zero_grad()
        total.backward()
        opt.step()
        if first is None:
            first = total.item()
        last = total.item()
        if step % max(1, cfg.train.max_steps // 10) == 0 or step == cfg.train.max_steps - 1:
            print(f"  step {step:4d}  total={total.item():.4f}  recon={recon.item():.4f}  trans={trans_l.item():.4f}")

    decreased = last < first
    print(f"[train] first={first:.4f} last={last:.4f} decreased={decreased}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"config": cfg.to_dict(), "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": trans.state_dict()}, out)
    print(f"[train] saved checkpoint → {out}")
    return 0 if decreased else 1


if __name__ == "__main__":
    raise SystemExit(main())
