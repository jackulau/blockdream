"""Train the browser-lineage latent-diffusion world model on REAL footage, then it can be exported
to ONNX (mineworld_wm.export_onnx --checkpoint) for the server-free in-browser engine. This is the
">=30fps route": the whole frame's latent is denoised in a few parallel Euler steps (resolution-
independent), unlike the AR path's sequential per-token decode.

Two phases, resumable, bounded by --max-minutes:
  1. tokenizer (continuous AE, vq_codebook_size=0) — reconstruct frames into a latent grid.
  2. rectified-flow transition — predict next-frame latent from (prev latent, action).

    ml/.venv/bin/python scripts/train_diffusion.py --pool data/pool_m4 --out runs/diffusion \
        --size 64 --max-frames 8000 --tok-steps 4000 --trans-steps 16000 --max-minutes 40
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from mineworld_wm.actions import ActionEncoder
from mineworld_wm.data_pool import load_pools
from mineworld_wm.device import device_name, pick_device
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.train_long import _atomic_save, _log
from mineworld_wm.train_real import make_config
from mineworld_wm.transition_diffusion import LatentDiffusionTransition


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("train_diffusion")
    ap.add_argument("--pool", default="data/pool_m4")
    ap.add_argument("--pools", default=None, help="comma-separated pools (overrides --pool)")
    ap.add_argument("--out", default="runs/diffusion")
    ap.add_argument("--preset", default="quick")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--size", type=int, default=64, help="train resolution (frames resized to this)")
    ap.add_argument("--max-frames", type=int, default=8000, help="cap frames for memory/time")
    ap.add_argument("--tok-steps", type=int, default=4000)
    ap.add_argument("--trans-steps", type=int, default=16000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--ckpt-every-min", type=float, default=5.0)
    ap.add_argument("--max-minutes", type=float, default=40.0)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dev = pick_device(args.device)
    torch.manual_seed(args.seed)

    dirs = args.pools.split(",") if args.pools else [args.pool]
    frames_np, actions_np, pairs, _skills = load_pools(dirs)
    # subsample + resize to the train resolution
    if frames_np.shape[0] > args.max_frames:
        keep = np.random.default_rng(args.seed).choice(frames_np.shape[0], args.max_frames, replace=False)
        keep.sort()
        remap = {int(o): i for i, o in enumerate(keep)}
        frames_np = frames_np[keep]
        actions_np = actions_np[keep]
        pairs = np.array([[remap[int(a)], remap[int(b)]] for a, b in pairs if int(a) in remap and int(b) in remap])
    frames = torch.from_numpy(frames_np).permute(0, 3, 1, 2).contiguous()  # (N,3,H,W) uint8
    if frames.shape[2] != args.size:
        frames = F.interpolate(frames.float(), size=(args.size, args.size), mode="area").round().clamp(0, 255).to(torch.uint8)
    buttons = torch.from_numpy(actions_np[:, :9]).float()
    camera = torch.from_numpy(actions_np[:, 9:]).float()
    H = frames.shape[2]

    cfg = make_config(H, args.preset)
    cfg.dynamics.kind = "diffusion"
    cfg.tokenizer.vq_codebook_size = 0  # continuous latents

    tok = Tokenizer(cfg.tokenizer).to(dev)
    enc = ActionEncoder(cfg.action).to(dev)
    trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim).to(dev)
    tok_opt = torch.optim.Adam(tok.parameters(), lr=args.lr)
    tr_opt = torch.optim.Adam(list(trans.parameters()) + list(enc.parameters()), lr=args.lr)

    phase, tok_step, tr_step = "tok", 0, 0
    latest = out / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location=dev, weights_only=False)
        tok.load_state_dict(ck["tokenizer"]); enc.load_state_dict(ck["action"]); trans.load_state_dict(ck["transition"])
        tok_opt.load_state_dict(ck["tok_opt"]); tr_opt.load_state_dict(ck["tr_opt"])
        phase, tok_step, tr_step = ck["phase"], ck["tok_step"], ck["tr_step"]
        print(f"[diffusion] RESUMED phase={phase} tok_step={tok_step} tr_step={tr_step}")

    print(f"[diffusion] {frames.shape[0]} frames @ {H}px, {len(pairs)} pairs  device={device_name(dev)}  preset={args.preset}")
    t0 = time.time()
    last_ckpt = [t0]

    def save(loss: float, val: float) -> None:
        _atomic_save(
            {
                "phase": phase, "tok_step": tok_step, "tr_step": tr_step,
                "config": cfg.to_dict(), "kind": "diffusion",
                "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": trans.state_dict(),
                "tok_opt": tok_opt.state_dict(), "tr_opt": tr_opt.state_dict(),
                "init_frame": frames[0].float().div(255).clone(),
            },
            latest,
        )
        _log(out, {"t": int(time.time()), "phase": phase, "step": tok_step if phase == "tok" else tr_step,
                   "loss": round(loss, 4), "val": round(val, 4), "mins": round((time.time() - t0) / 60, 1)})

    def time_up() -> bool:
        return (args.max_minutes > 0 and (time.time() - t0) / 60 >= args.max_minutes) or (out / "STOP").exists()

    def maybe_ckpt(loss: float, val: float = 0.0) -> None:
        if (time.time() - last_ckpt[0]) / 60 >= args.ckpt_every_min:
            save(loss, val)
            last_ckpt[0] = time.time()
            if dev.type == "mps":
                torch.mps.empty_cache()

    # ---- PHASE 1: tokenizer ----
    while phase == "tok" and tok_step < args.tok_steps and not time_up():
        idx = torch.randint(0, frames.shape[0], (args.batch,))
        out_t = tok(frames[idx].to(dev).float().div(255))
        tok_opt.zero_grad(); out_t.loss.backward(); tok_opt.step()
        tok_step += 1
        maybe_ckpt(out_t.recon_loss.item())
    if tok_step >= args.tok_steps and phase == "tok":
        phase = "trans"; save(0.0, 0.0); last_ckpt[0] = time.time()
    if time_up():
        save(0.0, 0.0); print("[diffusion] time budget reached — resume to continue"); return 0

    # cache latents for the transition phase
    lat_path = out / "latents.pt"
    if lat_path.exists():
        latents = torch.load(lat_path, map_location="cpu")
    else:
        with torch.no_grad():
            chunks = [tok.encode(frames[i:i + 64].to(dev).float().div(255)).cpu() for i in range(0, frames.shape[0], 64)]
        latents = torch.cat(chunks)
        _atomic_save(latents, lat_path)

    # ---- PHASE 2: diffusion transition ----
    def batch(pair_arr):
        sel = pair_arr[np.random.randint(0, len(pair_arr), args.batch)]
        prev = latents[sel[:, 0]].to(dev)
        nxt = latents[sel[:, 1]].to(dev)
        action = enc(buttons[sel[:, 0]].to(dev), camera[sel[:, 0]].to(dev))
        return prev, nxt, action

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(pairs))
    n_val = max(1, int(len(pairs) * 0.05))
    val_pairs, train_pairs = pairs[perm[:n_val]], pairs[perm[n_val:]]

    while phase == "trans" and tr_step < args.trans_steps and not time_up():
        prev, nxt, action = batch(train_pairs)
        loss = trans.loss(nxt, prev, action)
        tr_opt.zero_grad(); loss.backward(); tr_opt.step()
        tr_step += 1
        if tr_step % 50 == 0:
            with torch.no_grad():
                vp, vn, va = batch(val_pairs)
                val = trans.loss(vn, vp, va).item()
            maybe_ckpt(loss.item(), val)

    save(0.0, 0.0)
    print(f"[diffusion] done: phase={phase} tok_step={tok_step} tr_step={tr_step}  → {latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
