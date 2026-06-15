"""DEPRECATED - SYNTHETIC, NOT SERVED. Trains the driving WM on the physics-SIM pool (data/drive_pool
from `drive.collect` + `drive.sim`) = SYNTHETIC data. The served driving model is now trained on 100%
REAL comma.ai commaVQ footage via `drive.train_real` + `scripts/train_drive_real.sh`. Kept for
research/repro only; `no_synthetic_guard.py` asserts the served checkpoint is the real one, not this.

Resumable long-run trainer for the multimodal driving world model.

Two-phase (RGB tokenizer -> multimodal transition), atomic time-based checkpoints,
train/val loss logging, a --max-minutes wall-clock budget, and automatic resume from
out/latest.pt. The checkpoint it writes is serve-compatible: `blockdream_wm.drive.serve
--checkpoint <out>/latest.pt` loads it directly. Built to survive overnight MPS runs
that get interrupted by sleep/crash (re-run the same command to continue).

    python -m blockdream_wm.drive.train_long --pool ml/data/drive_pool --out ml/runs/drive \
        --tok-steps 4000 --ar-steps 200000 --ckpt-every-min 20 --max-minutes 75

Stop early: touch <out>/STOP  (or Ctrl-C; the last checkpoint is intact).
"""

from __future__ import annotations

import argparse
import csv
import os
import time
from pathlib import Path

import numpy as np
import torch

from ..config import TokenizerConfig, DynamicsConfig
from ..tokenizer import Tokenizer
from ..device import pick_device, device_name
from .transition import DriveTransition
from .collect import prepare_pool, load_pool, load_windows

IMAGE = 64
DOWNSAMPLE = 8          # 64/8 = 8 -> 64 tokens
CODEBOOK = 256
N_LIDAR = 32
N_TEL = 6


def _atomic_save(obj, path: Path) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    torch.save(obj, tmp)
    os.replace(tmp, path)  # atomic - a crash mid-write can't corrupt latest.pt


def _log(out: Path, row: dict) -> None:
    f = out / "log.csv"
    new = not f.exists()
    with open(f, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["t", "phase", "step", "loss", "val", "mins"])
        if new:
            w.writeheader()
        w.writerow(row)


def build(dev, n_history: int = 0):
    tcfg = TokenizerConfig(image_size=IMAGE, base_channels=32, latent_channels=4, downsample=DOWNSAMPLE, vq_codebook_size=CODEBOOK)
    dcfg = DynamicsConfig(kind="ar", dim=128, depth=3, heads=4)
    n_tokens = (IMAGE // DOWNSAMPLE) ** 2
    tok = Tokenizer(tcfg).to(dev)
    trans = DriveTransition(dcfg, n_tokens=n_tokens, codebook_size=CODEBOOK, n_lidar=N_LIDAR, n_telemetry=N_TEL,
                            n_history=n_history).to(dev)
    return tcfg, dcfg, tok, trans


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.drive.train_long")
    ap.add_argument("--pool", default="ml/data/drive_pool")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rollouts", type=int, default=160, help="collected only if pool is empty")
    ap.add_argument("--steps", type=int, default=220, help="steps per rollout if collecting")
    ap.add_argument("--tok-steps", type=int, default=4000)
    ap.add_argument("--ar-steps", type=int, default=200000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--ckpt-every-min", type=float, default=20.0)
    ap.add_argument("--max-minutes", type=float, default=0.0)  # 0 = until step targets
    ap.add_argument("--roll-k", type=int, default=12, help="multi-step recursive rollout horizon for the telemetry/LiDAR loss (0 disables → pure single-step teacher forcing)")
    ap.add_argument("--roll-weight", type=float, default=1.0, help="weight of the recursive rollout loss vs the single-step loss")
    ap.add_argument("--n-history", type=int, default=0, help="temporal-context window: condition on the last N (control, telemetry) frames (0 = original single-step conditioning)")
    ap.add_argument("--hist-dropout", type=float, default=0.15, help="probability of zeroing the history window per batch (trains the fresh-reset condition the server starts from)")
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dev = pick_device(args.device)
    torch.manual_seed(args.seed)

    if not list(Path(args.pool).glob("roll_*.npz")):
        prepare_pool(args.rollouts, args.steps, args.pool)
    rgb_np, lidar_np, tel_np, ctl_np, pairs = load_pool(args.pool)
    rgb = torch.from_numpy(rgb_np).to(torch.uint8)              # CPU (N,3,S,S) - moved per-batch
    lidar = torch.from_numpy(lidar_np).float().to(dev)
    tel = torch.from_numpy(tel_np).float().to(dev)
    ctl = torch.from_numpy(ctl_np).float().to(dev)
    N = rgb.shape[0]

    # contiguous K-step windows for the recursive rollout loss (controllability + stability)
    windows = load_windows(args.pool, args.roll_k) if args.roll_k > 0 else None
    # contiguous (n_history+1)-step windows so the single-step loss can see REAL history rows
    # (a window's last two frames are the (prev, next) pair; the frames before them are history)
    hwindows = load_windows(args.pool, args.n_history + 1) if args.n_history > 0 else None

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(pairs))
    n_val = max(1, int(len(pairs) * args.val_frac))
    val_pairs, train_pairs = pairs[perm[:n_val]], pairs[perm[n_val:]]
    val_hw = train_hw = None
    if hwindows is not None:
        hperm = rng.permutation(len(hwindows))
        n_hval = max(1, int(len(hwindows) * args.val_frac))
        val_hw, train_hw = hwindows[hperm[:n_hval]], hwindows[hperm[n_hval:]]

    tcfg, dcfg, tok, trans = build(dev, args.n_history)
    tok_opt = torch.optim.Adam(tok.parameters(), lr=args.lr)
    tr_opt = torch.optim.Adam(trans.parameters(), lr=args.lr)

    # resume
    phase, tok_step, ar_step = "tok", 0, 0
    latest = out / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location=dev, weights_only=False)
        tok.load_state_dict(ck["tokenizer"]); trans.load_state_dict(ck["transition"])
        if "tok_opt" in ck:
            tok_opt.load_state_dict(ck["tok_opt"])
        if "tr_opt" in ck:
            tr_opt.load_state_dict(ck["tr_opt"])
        phase, tok_step, ar_step = ck.get("phase", "tok"), ck.get("tok_step", 0), ck.get("ar_step", 0)
        print(f"[drive.train_long] RESUMED phase={phase} tok_step={tok_step} ar_step={ar_step}")

    print(f"[drive.train_long] {N} frames, {len(pairs)} pairs  device={device_name(dev)}")
    t0 = time.time()
    last_ckpt = t0

    def rgb_batch(idx):
        return rgb[idx].to(dev).float().div(255)

    best_val = [float("inf")]
    best_path = out / "best.pt"

    def _state():
        with torch.no_grad():
            init_tok = tok.tokenize(rgb[0:1].to(dev).float().div(255)).flatten(1)[0]
        return {
            "phase": phase, "tok_step": tok_step, "ar_step": ar_step,
            "tokenizer_cfg": vars(tcfg), "dynamics_cfg": vars(dcfg),
            "n_lidar": N_LIDAR, "n_telemetry": N_TEL, "image": IMAGE, "downsample": DOWNSAMPLE, "codebook": CODEBOOK,
            "n_history": args.n_history,
            "tokenizer": tok.state_dict(), "transition": trans.state_dict(),
            "tok_opt": tok_opt.state_dict(), "tr_opt": tr_opt.state_dict(),
            "init_tokens": init_tok.cpu(), "init_lidar": lidar[0].cpu(), "init_telemetry": tel[0].cpu(),
            "init_rgb": rgb[0].clone(),
        }

    def save(loss: float, val: float):
        _atomic_save(_state(), latest)
        if val > 0 and val < best_val[0]:  # keep the best-by-val checkpoint (avoid the overfit tail)
            best_val[0] = val
            _atomic_save(_state(), best_path)
        _log(out, {"t": int(time.time()), "phase": phase, "step": tok_step if phase == "tok" else ar_step,
                   "loss": round(loss, 4), "val": round(val, 4), "mins": round((time.time() - t0) / 60, 1)})

    def time_up() -> bool:
        if (out / "STOP").exists():
            return True
        return args.max_minutes > 0 and (time.time() - t0) / 60 >= args.max_minutes

    def maybe_ckpt(loss: float, val: float):
        nonlocal last_ckpt
        if (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
            save(loss, val)
            last_ckpt = time.time()
            if dev.type == "mps":
                torch.mps.empty_cache()

    # ---- PHASE 1: RGB tokenizer ----
    while phase == "tok" and tok_step < args.tok_steps and not time_up():
        idx = torch.randint(0, N, (args.batch,))
        o = tok(rgb_batch(idx))
        tok_opt.zero_grad(); o.loss.backward(); tok_opt.step()
        tok_step += 1
        maybe_ckpt(o.recon_loss.item(), 0.0)
    if phase == "tok" and tok_step >= args.tok_steps:
        phase = "ar"
        save(0.0, 0.0)
        last_ckpt = time.time()

    if time_up():
        save(0.0, 0.0)
        print("[drive.train_long] time budget reached - checkpoint saved, resume to continue")
        return 0

    # precompute pool tokens with the (now frozen) tokenizer; cached across resumes
    tokens_path = out / "tokens.pt"
    if tokens_path.exists():
        tokens = torch.load(tokens_path, map_location=dev)
    else:
        chunks = []
        with torch.no_grad():
            for i in range(0, N, 64):
                chunks.append(tok.tokenize(rgb[i:i + 64].to(dev).float().div(255)).flatten(1))
        tokens = torch.cat(chunks)
        _atomic_save(tokens.cpu(), tokens_path)
        tokens = tokens.to(dev)

    def ar_batch(parr):
        b = parr[np.random.randint(0, len(parr), args.batch)]
        i0 = torch.from_numpy(b[:, 0]).to(dev)
        i1 = torch.from_numpy(b[:, 1]).to(dev)
        return i0, i1, None

    def h_batch(warr, dropout: float):
        """(prev, next, history) from an (n_history+2)-frame window: last two frames are the
        pair, the frames before them are the REAL (control, telemetry) history rows."""
        w = torch.from_numpy(warr[np.random.randint(0, len(warr), args.batch)]).to(dev)
        hist = torch.cat([torch.cat([ctl[w[:, j]], tel[w[:, j]]], dim=-1) for j in range(args.n_history)], dim=-1)
        if dropout > 0 and np.random.random() < dropout:
            hist = torch.zeros_like(hist)  # fresh-reset condition (server starts with a zero window)
        return w[:, -2], w[:, -1], hist

    # ---- PHASE 2: multimodal transition ----
    def roll_batch():
        """Sample a batch of K-step windows → (tel0, lidar0, controls, tel_targets, lidar_targets)."""
        w = torch.from_numpy(windows[np.random.randint(0, len(windows), args.batch)]).to(dev)
        ctrls = ctl[w[:, :-1]]          # (B,K,3) control applied at each step
        return tel[w[:, 0]], lidar[w[:, 0]], ctrls, tel[w[:, 1:]], lidar[w[:, 1:]]

    while phase == "ar" and ar_step < args.ar_steps and not time_up():
        i0, i1, hist = h_batch(train_hw, args.hist_dropout) if train_hw is not None else ar_batch(train_pairs)
        loss, _ = trans.loss(tokens[i0], tokens[i1], lidar[i0], tel[i0], ctl[i0], lidar[i1], tel[i1], history=hist)
        if windows is not None:  # recursive multi-step loss on the telemetry/LiDAR feedback path
            t0_, l0_, cw, tt, lt = roll_batch()
            rloss, _ = trans.rollout_loss(t0_, l0_, cw, tt, lt)  # zero-init window; slides internally
            loss = loss + args.roll_weight * rloss
        tr_opt.zero_grad(); loss.backward(); tr_opt.step()
        ar_step += 1
        if ar_step % 50 == 0 or (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
            with torch.no_grad():
                vi0, vi1, vhist = h_batch(val_hw, 0.0) if val_hw is not None else ar_batch(val_pairs)
                vloss, _ = trans.loss(tokens[vi0], tokens[vi1], lidar[vi0], tel[vi0], ctl[vi0], lidar[vi1], tel[vi1], history=vhist)
            if vloss.item() < best_val[0]:  # track the peak at every val eval (avoid overfit tail)
                best_val[0] = vloss.item()
                _atomic_save(_state(), best_path)
            maybe_ckpt(loss.item(), vloss.item())

    save(0.0, 0.0)
    print(f"[drive.train_long] done: phase={phase} tok_step={tok_step} ar_step={ar_step}  → {latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
