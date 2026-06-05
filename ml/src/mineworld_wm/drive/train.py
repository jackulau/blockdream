"""Train the multimodal driving world model on sim rollouts, save a checkpoint the
WS server serves. MPS-capable. Toy/CPU-or-MPS scale; scales with rollouts + steps."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from ..config import TokenizerConfig, DynamicsConfig
from ..tokenizer import Tokenizer
from ..device import pick_device, device_name
from .transition import DriveTransition
from .collect import prepare_pool, load_pool

IMAGE = 64
DOWNSAMPLE = 8          # 64/8 = 8 → 64 tokens
CODEBOOK = 256
N_LIDAR = 32
N_TEL = 6


def build(dev):
    tcfg = TokenizerConfig(image_size=IMAGE, base_channels=32, latent_channels=4, downsample=DOWNSAMPLE, vq_codebook_size=CODEBOOK)
    dcfg = DynamicsConfig(kind="ar", dim=128, depth=3, heads=4)
    n_tokens = (IMAGE // DOWNSAMPLE) ** 2
    tok = Tokenizer(tcfg).to(dev)
    trans = DriveTransition(dcfg, n_tokens=n_tokens, codebook_size=CODEBOOK, n_lidar=N_LIDAR, n_telemetry=N_TEL).to(dev)
    return tcfg, dcfg, tok, trans


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.drive.train")
    ap.add_argument("--pool", default="ml/data/drive_pool")
    ap.add_argument("--rollouts", type=int, default=40)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--tok-steps", type=int, default=400)
    ap.add_argument("--ar-steps", type=int, default=600)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--out", default="ml/checkpoints/drive.pt")
    args = ap.parse_args(argv)

    torch.manual_seed(0)
    dev = pick_device(args.device)
    if not list(Path(args.pool).glob("roll_*.npz")):
        prepare_pool(args.rollouts, args.steps, args.pool)
    rgb_np, lidar_np, tel_np, ctl_np, pairs = load_pool(args.pool)
    rgb = torch.from_numpy(rgb_np).float().div(255).to(dev)
    lidar = torch.from_numpy(lidar_np).float().to(dev)
    tel = torch.from_numpy(tel_np).float().to(dev)
    ctl = torch.from_numpy(ctl_np).float().to(dev)
    N = rgb.shape[0]
    tcfg, dcfg, tok, trans = build(dev)
    print(f"[drive.train] {N} frames, {len(pairs)} pairs  device={device_name(dev)}")

    # 1) RGB tokenizer
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for _ in range(args.tok_steps):
        idx = torch.randint(0, N, (args.batch,), device=dev)
        out = tok(rgb[idx])
        topt.zero_grad(); out.loss.backward(); topt.step()
    with torch.no_grad():
        toks = torch.cat([tok.tokenize(rgb[i:i + 64]).flatten(1) for i in range(0, N, 64)])

    # 2) multimodal transition
    p0, p1 = pairs[:, 0], pairs[:, 1]
    opt = torch.optim.Adam(trans.parameters(), lr=2e-3)
    first = None
    for _ in range(args.ar_steps):
        b = np.random.randint(0, len(pairs), args.batch)
        i0 = torch.from_numpy(p0[b]).to(dev)
        i1 = torch.from_numpy(p1[b]).to(dev)
        loss, parts = trans.loss(toks[i0], toks[i1], lidar[i0], tel[i0], ctl[i0], lidar[i1], tel[i1])
        opt.zero_grad(); loss.backward(); opt.step()
        if first is None:
            first = loss.item()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tok.cpu(); trans.cpu()
    torch.save({
        "tokenizer_cfg": vars(tcfg), "dynamics_cfg": vars(dcfg),
        "n_lidar": N_LIDAR, "n_telemetry": N_TEL, "image": IMAGE, "downsample": DOWNSAMPLE, "codebook": CODEBOOK,
        "tokenizer": tok.state_dict(), "transition": trans.state_dict(),
        "init_tokens": toks[0].cpu(), "init_lidar": lidar[0].cpu(), "init_telemetry": tel[0].cpu(),
        "init_rgb": (rgb[0].cpu() * 255).byte(),
    }, out)
    print(f"[drive.train] loss {first:.3f}->{loss.item():.3f}  parts={parts}  → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
