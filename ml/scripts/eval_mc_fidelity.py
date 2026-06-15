"""Fidelity gate for the served Minecraft world model — does the rolled-out frame actually LOOK like
Minecraft, or is it blurry/gray mush?

The distinctness gate (verify_movement_types.py) proves the movement types DIVERGE, but a model can be
divergent AND blurry. This measures VISUAL FIDELITY of the recursive rollout:

  detail  = mean gradient magnitude (high-frequency energy) of decoded frames — blur/gray mush has LOW
            detail; real Minecraft (block edges, texture) has HIGH detail. The headline number is
            `detail_ratio` = rollout detail / real-holdout detail (1.0 = as sharp as real footage).
  sat     = mean per-pixel color saturation (channel spread) — a sanity channel.
  std     = mean spatial std — catches a literal gray collapse.

Floor gate (exit 1) fires ONLY on a catastrophic collapse (std below the gray floor, or detail_ratio
near zero). Otherwise exit 0 and print FIDELITY <detail_ratio>. Use --min-detail-ratio to gate harder
(promote-if-better compares the printed ratio). Prints one verdict line: FIDELITY_OK / FIDELITY_LOW.

    ml/.venv/bin/python scripts/eval_mc_fidelity.py --checkpoint runs/skills_real/latest.pt
"""

from __future__ import annotations

import argparse
import glob
import sys

import numpy as np
import torch

from blockdream_wm.serve import load_real_checkpoint
from blockdream_wm.movement import MOVEMENT_TYPES, skill_id

GRAY_STD_FLOOR = 0.06          # below this, the frame is a flat gray collapse
DETAIL_FLOOR = 0.15            # detail_ratio below this = near-flat (broken)


def _detail(f: torch.Tensor) -> float:
    """Mean gradient magnitude (HF energy / sharpness) of a (3,H,W) frame in [0,1]."""
    f = torch.as_tensor(f).float()
    dx = (f[..., 1:, :] - f[..., :-1, :]).abs().mean()
    dy = (f[..., :, 1:] - f[..., :, :-1]).abs().mean()
    return float((dx + dy) / 2)


def _sat(f: torch.Tensor) -> float:
    f = torch.as_tensor(f).float()
    return float((f.max(0).values - f.min(0).values).mean())


def _real_baseline(n_per_pool: int = 12) -> tuple[float, float]:
    """Mean (detail, sat) over a real-footage holdout — the fidelity target."""
    det, sat = [], []
    for p in sorted(glob.glob("data/pool_real_*")):
        segs = sorted(glob.glob(p + "/seg_*.npz"))
        if not segs:
            continue
        fr = np.load(segs[0])["frames"].astype(np.float32) / 255.0
        idx = np.linspace(0, len(fr) - 1, num=min(n_per_pool, len(fr)), dtype=np.int64)
        for f in fr[idx]:
            t = torch.from_numpy(f).permute(2, 0, 1)
            det.append(_detail(t)); sat.append(_sat(t))
    if not det:
        return 0.0318, 0.1625  # fallback to the measured real baseline
    return float(np.mean(det)), float(np.mean(sat))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("eval_mc_fidelity")
    ap.add_argument("--checkpoint", default="runs/skills_real/latest.pt")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--steps", type=int, default=20, help="rollout steps per skill before measuring")
    ap.add_argument("--skills", default="walk,general,sprint,jump,pig",
                    help="comma-separated movement types to roll out")
    ap.add_argument("--min-detail-ratio", type=float, default=0.0,
                    help="extra gate: FIDELITY_LOW if rollout detail/real < this (0 = floor-only)")
    args = ap.parse_args(argv)

    real_det, real_sat = _real_baseline()
    s = load_real_checkpoint(args.checkpoint, device=args.device)
    btn = torch.zeros(9); btn[0] = 1.0; cam = torch.zeros(2)

    dets, sats, stds = [], [], []
    for mv in [m.strip() for m in args.skills.split(",") if m.strip() in MOVEMENT_TYPES]:
        s.skill = skill_id(mv); s.reset()
        for _ in range(args.steps):
            r = s.step(btn, cam)
        dets.append(_detail(r.frame)); sats.append(_sat(r.frame)); stds.append(float(r.frame.float().std()))

    detail = float(np.mean(dets)); sat = float(np.mean(sats)); std = float(np.mean(stds))
    ratio = detail / real_det if real_det > 0 else 0.0
    print(f"[mc-fidelity] real baseline: detail={real_det:.4f} sat={real_sat:.4f}")
    print(f"[mc-fidelity] rollout: detail={detail:.4f} sat={sat:.4f} std={std:.4f}")
    print(f"[mc-fidelity] detail_ratio={ratio:.3f} (1.0 = as sharp as real footage)")
    print(f"FIDELITY {ratio:.3f}")

    collapsed = std < GRAY_STD_FLOOR or ratio < DETAIL_FLOOR
    low = args.min_detail_ratio > 0 and ratio < args.min_detail_ratio
    if collapsed:
        print(f"FIDELITY_LOW — collapsed (std {std:.3f} < {GRAY_STD_FLOOR} or ratio {ratio:.3f} < {DETAIL_FLOOR})")
        return 1
    if low:
        print(f"FIDELITY_LOW — detail_ratio {ratio:.3f} < required {args.min_detail_ratio}")
        return 1
    print("FIDELITY_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
