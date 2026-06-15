"""Extract REAL, action-labeled per-skill pools from the VPT pool (pool_m4) for the movement types
that ARE present in human walking-gameplay footage: sprint, jump, walk. VPT logs the exact keyboard
state per frame (sprint=idx6, jump=idx4, forward=idx0), so these are genuine human footage - no
synthetic stand-in needed. (boat/elytra/pig/swim/minecart aren't button-distinguishable in VPT and
come from the mineflayer collector instead.)

For each skill we scan every pool_m4 segment for CONTIGUOUS runs matching the skill (so the extracted
frames are real consecutive transitions, not scattered singletons), downsample 128→64px, and write a
tagged pool_real_<skill>64.

    ml/.venv/bin/python scripts/extract_real_from_vpt.py --src data/pool_m4
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

# VPT button indices (vpt_actions.py): [forward, back, left, right, jump, sneak, sprint, attack, use]
FWD, JUMP, SPRINT = 0, 4, 6


def _downsample2x(frames: np.ndarray) -> np.ndarray:
    n, h, w, c = frames.shape
    if h == 64:
        return frames
    f = frames.astype(np.float32).reshape(n, h // 2, 2, w // 2, 2, c).mean(axis=(2, 4))
    return np.clip(f, 0, 255).astype(np.uint8)


def _runs(mask: np.ndarray, min_run: int):
    """Yield (start, end) index ranges where mask is True for >= min_run consecutive frames."""
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if j - i >= min_run:
                yield i, j
            i = j
        else:
            i += 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("extract_real_from_vpt")
    ap.add_argument("--src", default="data/pool_m4")
    ap.add_argument("--outdir", default="data")
    ap.add_argument("--min-run", type=int, default=12, help="min consecutive frames for a run (1.2s @10fps)")
    ap.add_argument("--budget", type=int, default=2560, help="approx frames per skill pool")
    args = ap.parse_args(argv)

    segs = sorted(Path(args.src).glob("seg_*.npz"))
    if not segs:
        raise SystemExit(f"no seg_*.npz in {args.src}")

    # per-skill predicate over the (N,11) action array → boolean mask
    def sprint_mask(a):  # running: forward + sprint held
        return (a[:, FWD] > 0.5) & (a[:, SPRINT] > 0.5)

    def walk_mask(a):    # steady walking: forward, NOT sprinting
        return (a[:, FWD] > 0.5) & (a[:, SPRINT] < 0.5)

    def jump_mask(a):    # forward held with jumping mixed in (bunny-hop / jump-move): widen taps by ±4 frames
        j = a[:, JUMP] > 0.5
        wide = np.convolve(j.astype(np.float32), np.ones(9), "same") > 0.5
        return (a[:, FWD] > 0.5) & wide

    skills = {"sprint": sprint_mask, "jump": jump_mask, "walk": walk_mask}
    writers = {s: 0 for s in skills}
    totals = {s: 0 for s in skills}
    out_dirs = {}
    for s in skills:
        d = Path(args.outdir) / f"pool_real_{s}64"
        d.mkdir(parents=True, exist_ok=True)
        (d / "skill.txt").write_text(s)
        out_dirs[s] = d

    for seg in segs:
        if all(totals[s] >= args.budget for s in skills):
            break
        d = np.load(seg)
        frames, actions = d["frames"], d["actions"]
        for s, pred in skills.items():
            if totals[s] >= args.budget:
                continue
            mask = pred(actions)
            for a, b in _runs(mask, args.min_run):
                if totals[s] >= args.budget:
                    break
                fr = _downsample2x(frames[a:b])
                np.savez_compressed(out_dirs[s] / f"seg_{writers[s]:05d}.npz", frames=fr, actions=actions[a:b])
                writers[s] += 1
                totals[s] += fr.shape[0]

    for s in skills:
        print(f"[extract] pool_real_{s}64: {writers[s]} runs, {totals[s]} real frames @64px")
    return 0 if all(totals[s] > 0 for s in skills) else 1


if __name__ == "__main__":
    raise SystemExit(main())
