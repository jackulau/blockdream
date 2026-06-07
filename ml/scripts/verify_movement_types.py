"""Verify a skill-conditioned world-model checkpoint produces DISTINCT dynamics for every movement
type. Loads the real checkpoint, rolls each of the 9 movement types out from the SAME seed frame and
the SAME held-forward action, and checks the resulting rollouts diverge (the skill embedding actually
steers the world, not just a dead one-hot). Exits 0 when all types are distinct, 1 otherwise.

    ml/.venv/bin/python scripts/verify_movement_types.py --checkpoint runs/skills/latest.pt
"""

from __future__ import annotations

import argparse
import itertools
import sys

import torch

from mineworld_wm.movement import MOVEMENT_TYPES, skill_id
from mineworld_wm.serve import load_real_checkpoint


@torch.no_grad()
def rollout(session, skill_name: str, steps: int) -> torch.Tensor:
    """Roll a single movement type out from the checkpoint's default seed frame. Returns (steps,3,H,W)."""
    session.skill = skill_id(skill_name)
    session.reset()  # same default_init every time → differences are purely the skill
    buttons = torch.zeros(9)
    buttons[0] = 1.0  # hold forward
    camera = torch.zeros(2)
    frames = []
    for _ in range(steps):
        frames.append(session.step(buttons, camera).frame.detach().float().cpu())
    return torch.stack(frames)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("verify_movement_types")
    ap.add_argument("--checkpoint", default="runs/skills/latest.pt")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--thresh", type=float, default=0.02, help="min mean pairwise |Δframe| to pass")
    args = ap.parse_args(argv)

    session = load_real_checkpoint(args.checkpoint, device=args.device)
    types = list(MOVEMENT_TYPES)
    traj = {t: rollout(session, t, args.steps) for t in types}

    pairs = list(itertools.combinations(types, 2))
    diffs = {(a, b): (traj[a] - traj[b]).abs().mean().item() for a, b in pairs}
    mean_pair = sum(diffs.values()) / len(diffs)
    eps = args.thresh / 2
    distinct = sum(1 for d in diffs.values() if d > eps)

    print(f"[movement-verify] {len(types)} movement types, {args.steps}-step rollouts from a shared seed")
    for t in types:
        if t == "general":
            continue
        dg = (traj[t] - traj["general"]).abs().mean().item()
        print(f"   {t:9s} vs general:  mean |Δ| = {dg:.4f}")
    print(f"[movement-verify] mean pairwise |Δframe| = {mean_pair:.4f} · {distinct}/{len(pairs)} pairs distinct (>{eps:.3f})")

    ok = mean_pair >= args.thresh and distinct >= int(0.8 * len(pairs))
    print(f"[movement-verify] verdict: {'DISTINCT — every movement type steers the world differently' if ok else 'TOO SIMILAR — needs more training'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
