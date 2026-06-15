"""Build REAL walk/general skill pools at 64px from the real VPT pool (pool_m4, 128px).

This downsamples contiguous pool_m4 segments (real OpenAI VPT contractor footage) to 64px and writes
them as two tagged pools - `walk` and `general`. It is ONE link in the all-real data chain for the
served Minecraft world model; the other movement types are ALSO 100% real - sprint/jump come from
VPT's labeled buttons (extract_real_from_vpt.py) and swim/boat/elytra/pig/minecart come from real
mineflayer gameplay footage (import_mineflayer.py). ZERO synthetic data feeds the served model.
Temporal contiguity is preserved per segment (within-segment consecutive pairs stay valid).

(Historical: an earlier proof used procedural synthetic pools - gen_movement_data.py, now DEPRECATED -
for the exotic skills before real footage was collected. That path is no longer used or served.)

    ml/.venv/bin/python scripts/prep_real_skill_pools.py --src data/pool_m4 --frames-per 2560
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np


def _downsample2x(frames: np.ndarray) -> np.ndarray:
    """(N,128,128,3) uint8 → (N,64,64,3) uint8 by 2×2 area-average (keeps real texture, no aliasing)."""
    n, h, w, c = frames.shape
    f = frames.astype(np.float32).reshape(n, h // 2, 2, w // 2, 2, c).mean(axis=(2, 4))
    return np.clip(f, 0, 255).astype(np.uint8)


def _write_pool(segs: list[Path], out: Path, skill: str, frames_budget: int) -> int:
    out.mkdir(parents=True, exist_ok=True)
    (out / "skill.txt").write_text(skill)
    written = total = 0
    for s in segs:
        if total >= frames_budget:
            break
        d = np.load(s)
        f, a = d["frames"], d["actions"]
        if f.shape[1] != 64:  # downsample 128→64 if needed
            f = _downsample2x(f)
        np.savez_compressed(out / f"seg_{written:05d}.npz", frames=f, actions=a)
        written += 1
        total += f.shape[0]
    print(f"[prep] {out.name}: {written} segments, {total} frames @64px (skill={skill})")
    return total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("prep_real_skill_pools")
    ap.add_argument("--src", default="data/pool_m4", help="real VPT pool (128px segments)")
    ap.add_argument("--frames-per", type=int, default=2560, help="approx frames per output pool")
    ap.add_argument("--outdir", default="data")
    args = ap.parse_args(argv)

    src = Path(args.src)
    segs = sorted(src.glob("seg_*.npz"))
    if not segs:
        raise SystemExit(f"no seg_*.npz in {src}")
    half = len(segs) // 2
    # disjoint segment ranges → general and walk see different real footage (no overlap leakage)
    n_g = _write_pool(segs[:half], Path(args.outdir) / "pool_real_general64", "general", args.frames_per)
    n_w = _write_pool(segs[half:], Path(args.outdir) / "pool_real_walk64", "walk", args.frames_per)
    print(f"[prep] done: general={n_g} frames, walk={n_w} frames")
    return 0 if (n_g and n_w) else 1


if __name__ == "__main__":
    raise SystemExit(main())
