"""Resumable trainer for the REAL driving world model on commaVQ.

commaVQ ships pre-tokenized real dashcam video (128 tokens/frame, codebook 1024) + ego pose, so there
is NO RGB-tokenizer phase here (unlike the sim `drive.train_long`): the control-conditioned recursive
transition trains directly on the real tokens, with a real-pose-derived telemetry head + recursive
rollout loss for controllability. The checkpoint it writes is serve-compatible and carries
`real_source="commavq"` so `drive.serve` / `eval_drive_control` treat it as a camera-only real model
(no LiDAR, token-field render).

    python -m blockdream_wm.drive.train_real --pool ml/data/drive_real_pool --out ml/runs/drive_real \
        --ar-steps 6000 --max-minutes 20 --device mps

Resume: re-run the same command (continues from out/latest.pt). Stop early: touch <out>/STOP.
"""

from __future__ import annotations

import argparse
import csv
import os
import time
from pathlib import Path

import numpy as np
import torch

from ..config import DynamicsConfig
from ..device import pick_device, device_name
from .transition import DriveTransition
from .commavq import (
    TOKENS_PER_FRAME, COMMAVQ_CODEBOOK,
    load_real_token_pool, load_real_token_windows,
)

N_TEL = 6
N_LIDAR = 0


def _atomic_save(obj, path: Path) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    torch.save(obj, tmp)
    os.replace(tmp, path)


def _log(out: Path, row: dict) -> None:
    f = out / "log.csv"
    new = not f.exists()
    with open(f, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["t", "phase", "step", "loss", "val", "mins"])
        if new:
            w.writeheader()
        w.writerow(row)


def build(dev, n_history: int = 0, rgb_change_weight: float = 0.0,
          rgb_div_weight: float = 0.0, rgb_div_margin: float = 0.5,
          prev_corrupt: float = 0.0) -> tuple[DynamicsConfig, DriveTransition]:
    dcfg = DynamicsConfig(kind="ar", dim=128, depth=3, heads=4)
    trans = DriveTransition(dcfg, n_tokens=TOKENS_PER_FRAME, codebook_size=COMMAVQ_CODEBOOK,
                            n_lidar=N_LIDAR, n_telemetry=N_TEL, n_history=n_history,
                            rgb_change_weight=rgb_change_weight, rgb_div_weight=rgb_div_weight,
                            rgb_div_margin=rgb_div_margin, prev_corrupt=prev_corrupt).to(dev)
    return dcfg, trans


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.drive.train_real")
    ap.add_argument("--pool", default="ml/data/drive_real_pool")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ar-steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--ckpt-every-min", type=float, default=3.0)
    ap.add_argument("--max-minutes", type=float, default=0.0)
    ap.add_argument("--roll-k", type=int, default=12, help="recursive rollout horizon for the telemetry loss (0 disables)")
    ap.add_argument("--roll-weight", type=float, default=1.0)
    # RGB dynamics loss (the copy-previous fix — see DriveTransition). Default 0 = legacy single-step CE.
    ap.add_argument("--rgb-change-weight", type=float, default=0.0,
                    help="up-weight the RGB CE on changed tokens (next != prev) so the model can't win by copying prev")
    ap.add_argument("--rgb-div-weight", type=float, default=0.0,
                    help="control-divergence weight: true control must out-predict a shuffled control by --rgb-div-margin")
    ap.add_argument("--rgb-div-margin", type=float, default=0.5)
    ap.add_argument("--prev-corrupt", type=float, default=0.0,
                    help="fraction of prev-frame tokens randomized in training so the AR can't echo prev (copy fix)")
    ap.add_argument("--rgb-roll-k", type=int, default=0,
                    help="scheduled-sampling RGB rollout horizon (0=off): roll K steps feeding the model's own generated frame")
    ap.add_argument("--rgb-roll-weight", type=float, default=0.5)
    ap.add_argument("--rgb-roll-batch", type=int, default=8, help="batch for the (expensive) RGB rollout generates")
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dev = pick_device(args.device)
    torch.manual_seed(args.seed)

    tok_np, ctl_np, tel_np, pairs = load_real_token_pool(args.pool)
    tokens = torch.from_numpy(tok_np).long().to(dev)              # (N,128) real commaVQ tokens
    ctl = torch.from_numpy(ctl_np).float().to(dev)               # (N,3) real control
    tel = torch.from_numpy(tel_np).float().to(dev)               # (N,6) real telemetry
    lidar0 = torch.zeros((tokens.shape[0], 0), device=dev)        # camera-only: no LiDAR
    N = tokens.shape[0]

    windows = load_real_token_windows(args.pool, args.roll_k) if args.roll_k > 0 else None

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(pairs))
    n_val = max(1, int(len(pairs) * args.val_frac))
    val_pairs, train_pairs = pairs[perm[:n_val]], pairs[perm[n_val:]]

    dcfg, trans = build(dev, rgb_change_weight=args.rgb_change_weight,
                        rgb_div_weight=args.rgb_div_weight, rgb_div_margin=args.rgb_div_margin,
                        prev_corrupt=args.prev_corrupt)
    opt = torch.optim.Adam(trans.parameters(), lr=args.lr)

    ar_step = 0
    latest = out / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location=dev, weights_only=False)
        trans.load_state_dict(ck["transition"])
        if "opt" in ck:
            opt.load_state_dict(ck["opt"])
        ar_step = ck.get("ar_step", 0)
        print(f"[drive.train_real] RESUMED ar_step={ar_step}")

    print(f"[drive.train_real] {N} REAL frames, {len(pairs)} pairs  device={device_name(dev)}  (commaVQ, no LiDAR)")
    t0 = time.time()
    last_ckpt = t0
    best_val = [float("inf")]
    best_path = out / "best.pt"

    def _state():
        return {
            "real_source": "commavq",
            "ar_step": ar_step,
            "dynamics_cfg": vars(dcfg),
            "n_lidar": N_LIDAR, "n_telemetry": N_TEL, "n_tokens": TOKENS_PER_FRAME,
            "codebook": COMMAVQ_CODEBOOK, "token_grid": [8, 16], "n_history": 0,
            "rgb_change_weight": args.rgb_change_weight, "rgb_div_weight": args.rgb_div_weight,
            "prev_corrupt": args.prev_corrupt, "rgb_roll_k": args.rgb_roll_k,
            "transition": trans.state_dict(), "opt": opt.state_dict(),
            "init_tokens": tokens[0].cpu(), "init_lidar": lidar0[0].cpu(), "init_telemetry": tel[0].cpu(),
        }

    def save(loss: float, val: float):
        _atomic_save(_state(), latest)
        if val > 0 and val < best_val[0]:
            best_val[0] = val
            _atomic_save(_state(), best_path)
        _log(out, {"t": int(time.time()), "phase": "ar", "step": ar_step,
                   "loss": round(loss, 4), "val": round(val, 4), "mins": round((time.time() - t0) / 60, 1)})

    def time_up() -> bool:
        if (out / "STOP").exists():
            return True
        return args.max_minutes > 0 and (time.time() - t0) / 60 >= args.max_minutes

    def ar_batch(parr):
        b = parr[np.random.randint(0, len(parr), args.batch)]
        return torch.from_numpy(b[:, 0]).to(dev), torch.from_numpy(b[:, 1]).to(dev)

    def roll_batch():
        w = torch.from_numpy(windows[np.random.randint(0, len(windows), args.batch)]).to(dev)
        return tel[w[:, 0]], lidar0[w[:, 0]], ctl[w[:, :-1]], tel[w[:, 1:]], None

    while ar_step < args.ar_steps and not time_up():
        i0, i1 = ar_batch(train_pairs)
        loss, _ = trans.loss(tokens[i0], tokens[i1], lidar0[i0], tel[i0], ctl[i0], lidar0[i1], tel[i1])
        if windows is not None:
            t0_, l0_, cw, tt, _ = roll_batch()
            rloss, _ = trans.rollout_loss(t0_, l0_, cw, tt, None)
            loss = loss + args.roll_weight * rloss
        if args.rgb_roll_k > 0 and windows is not None:
            wr = torch.from_numpy(windows[np.random.randint(0, len(windows), args.rgb_roll_batch)]).to(dev)
            kk = min(args.rgb_roll_k, wr.shape[1] - 1)
            rgbroll, _ = trans.rgb_rollout_loss(tokens[wr[:, : kk + 1]], ctl[wr[:, :kk]], lidar0[wr[:, 0]], tel[wr[:, 0]])
            loss = loss + args.rgb_roll_weight * rgbroll
        opt.zero_grad(); loss.backward(); opt.step()
        ar_step += 1
        if ar_step % 50 == 0 or (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
            with torch.no_grad():
                vi0, vi1 = ar_batch(val_pairs)
                vloss, _ = trans.loss(tokens[vi0], tokens[vi1], lidar0[vi0], tel[vi0], ctl[vi0], lidar0[vi1], tel[vi1])
            if vloss.item() < best_val[0]:
                best_val[0] = vloss.item()
                _atomic_save(_state(), best_path)
            if (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
                save(loss.item(), vloss.item())
                last_ckpt = time.time()
                if dev.type == "mps":
                    torch.mps.empty_cache()

    save(0.0, 0.0)
    print(f"[drive.train_real] done: ar_step={ar_step}  → {latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
