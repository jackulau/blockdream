"""Import Mineflayer-collected episodes (tools/mineflayer-collector) into the tagged on-disk pool
format the world-model trainer consumes — so the Minecraft WM trains on REAL per-movement-type
footage + physics (the comma.ai analogue), not synthetic stand-ins.

For each <skill>.mp4 + <skill>.json under --in:
  • decode the mp4 to frames (ffmpeg, forced size, resampled to the clip fps)
  • align each frame with the nearest per-tick action (9 buttons + 2 camera) and PHYSICS telemetry
    (pos, vel, yaw/pitch, on-ground, in-water, speed) by timestamp
  • write data/pool_real_<skill>/seg_NNNNN.npz (frames, actions), skill.txt, and physics.npy —
    the seg index auto-increments past existing segments so re-imports append, never overwrite

    ml/.venv/bin/python scripts/import_mineflayer.py --in ../tools/mineflayer-collector/out --out data
Then train on the real pools:
    ml/.venv/bin/python -m blockdream_wm.train_long --pools data/pool_real_walk,data/pool_real_boat,... --out runs/real
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

N_BUTTONS = 9
BUTTON_ORDER = ["forward", "back", "left", "right", "jump", "sneak", "sprint", "attack", "use"]  # matches vpt_actions (attack=7, use=8)
PHYS_DIM = 11  # pos(3) + vel(3) + yaw + pitch + onGround + inWater + speed


def ticks_to_arrays(ticks: list[dict], n_frames: int, seconds: float) -> tuple[np.ndarray, np.ndarray]:
    """Resample per-tick action + physics logs onto `n_frames` evenly-spaced frame times. Pure +
    deterministic (no IO) so it is unit-testable. Returns (actions (n,11) f32, physics (n,PHYS_DIM) f32)."""
    actions = np.zeros((n_frames, N_BUTTONS + 2), dtype=np.float32)
    physics = np.zeros((n_frames, PHYS_DIM), dtype=np.float32)
    if not ticks:
        return actions, physics
    times = np.array([t.get("t", 0.0) for t in ticks], dtype=np.float64)
    for i in range(n_frames):
        ft = (i / max(1, n_frames - 1)) * seconds
        j = int(np.argmin(np.abs(times - ft)))  # nearest tick to this frame time
        tk = ticks[j]
        b = tk.get("buttons", {})
        for k, name in enumerate(BUTTON_ORDER):
            actions[i, k] = 1.0 if b.get(name) else 0.0
        cam = tk.get("camera", [0.0, 0.0])
        actions[i, N_BUTTONS] = float(cam[0]) if len(cam) > 0 else 0.0
        actions[i, N_BUTTONS + 1] = float(cam[1]) if len(cam) > 1 else 0.0
        p = tk.get("physics", {})
        pos, vel = p.get("pos", [0, 0, 0]), p.get("vel", [0, 0, 0])
        physics[i] = [
            pos[0], pos[1], pos[2], vel[0], vel[1], vel[2],
            p.get("yaw", 0.0), p.get("pitch", 0.0),
            1.0 if p.get("onGround") else 0.0, 1.0 if p.get("inWater") else 0.0, p.get("speed", 0.0),
        ]
    return actions, physics


def next_seg_index(pool: Path) -> int:
    """Next free seg index in `pool` (max existing seg_NNNNN.npz + 1, else 0) so re-imports
    append new segments instead of silently clobbering previously imported real data."""
    taken = [int(p.stem.split("_", 1)[1]) for p in pool.glob("seg_*.npz") if p.stem.split("_", 1)[1].isdigit()]
    return max(taken, default=-1) + 1


def decode_mp4(path: Path, size: int) -> np.ndarray:
    """ffmpeg -> (N, size, size, 3) uint8."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"scale={size}:{size}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout
    n = len(out) // (size * size * 3)
    return np.frombuffer(out[: n * size * size * 3], dtype=np.uint8).reshape(n, size, size, 3)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("import_mineflayer")
    ap.add_argument("--in", dest="inp", required=True, help="collector output dir (<skill>.mp4 + <skill>.json)")
    ap.add_argument("--out", default="data")
    args = ap.parse_args(argv)
    src = Path(args.inp)
    metas = sorted(src.glob("*.json"))
    if not metas:
        print(f"[import] no <skill>.json in {src}")
        return 1
    for meta_path in metas:
        meta = json.loads(meta_path.read_text())
        skill, size = meta["skill"], int(meta.get("size", 128))
        mp4 = src / f"{skill}.mp4"
        if not mp4.exists():
            print(f"[import] {skill}: missing {mp4.name}, skipping")
            continue
        frames = decode_mp4(mp4, size)
        actions, physics = ticks_to_arrays(meta.get("ticks", []), frames.shape[0], float(meta.get("seconds", 30)))
        out = Path(args.out) / f"pool_real_{skill}"
        out.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(out / f"seg_{next_seg_index(out):05d}.npz", frames=frames, actions=actions)
        np.save(out / "physics.npy", physics)
        (out / "skill.txt").write_text(skill)
        print(f"[import] {skill}: {frames.shape[0]} frames @ {size}px -> {out} (+physics {physics.shape})")
    print("[import] done. Train: -m blockdream_wm.train_long --pools data/pool_real_<skill>,... --out runs/real")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
