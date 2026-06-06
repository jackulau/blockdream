"""Collect multimodal driving rollouts (RGB + LiDAR + telemetry + control) with a
pursuit autopilot (+ noise for diversity), saved as a resumable pool of .npz."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

from .sim import DriveSim, DriveConfig, TRACK_KINDS


def _pursuit_action(sim: DriveSim, rng: np.random.Generator, target_speed: float = 11.0) -> tuple[float, float, float]:
    """Steer toward a lookahead point on the centerline; hold a target speed."""
    cl = sim.centerline
    car = np.array([sim.state.x, sim.state.y])
    i = int(np.argmin(((cl - car) ** 2).sum(1)))
    target = cl[(i + 6) % len(cl)]
    ego = sim._to_ego(target[None])[0]  # (fwd, left)
    heading_err = math.atan2(ego[1], ego[0])
    steer = float(np.clip(1.6 * heading_err, -1, 1)) + float(rng.normal(0, 0.05))
    spd = sim.state.speed()
    # ease off in sharp turns
    desired = target_speed * (1.0 - 0.5 * min(1.0, abs(steer)))
    throttle = float(np.clip((desired - spd) * 0.3, 0, 1)) + float(rng.normal(0, 0.05) > 0.04)
    brake = 1.0 if spd > desired + 4 else 0.0
    return float(np.clip(steer, -1, 1)), float(np.clip(throttle, 0, 1)), brake


def collect_rollout(steps: int, seed: int, cfg: DriveConfig | None = None) -> dict:
    sim = DriveSim(cfg, seed=seed)
    rng = np.random.default_rng(seed + 1)
    sim.reset()
    rgb, lidar, tel, ctrl = [], [], [], []
    for _ in range(steps):
        obs = sim.observation()
        a = _pursuit_action(sim, rng)
        rgb.append((obs["rgb"] * 255).astype(np.uint8))
        lidar.append(obs["lidar"])
        tel.append(obs["telemetry"])
        ctrl.append(np.array(a, dtype=np.float32))
        sim.step(*a)
    return {
        "rgb": np.stack(rgb),            # (T,3,S,S) uint8
        "lidar": np.stack(lidar),        # (T,n) f32
        "telemetry": np.stack(tel),      # (T,6) f32
        "control": np.stack(ctrl),       # (T,3) f32 [steer,throttle,brake]
    }


def prepare_pool(rollouts: int, steps: int, out: str, seed: int = 0) -> int:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(rollouts):
        f = out_dir / f"roll_{i:05d}.npz"
        if f.exists():
            continue
        track = TRACK_KINDS[i % len(TRACK_KINDS)]  # span track shapes for richer dynamics
        r = collect_rollout(steps, seed + i, DriveConfig(track=track))
        np.savez_compressed(f, **r)
        print(f"[drive.collect] {i + 1}/{rollouts}: {steps} steps ({track})")
    n = len(list(out_dir.glob("roll_*.npz")))
    print(f"[drive.collect] {n} rollouts in {out_dir}")
    return n


def load_pool(out: str):
    """→ (rgb uint8 (N,3,S,S), lidar (N,n), telemetry (N,6), control (N,3), pairs (P,2))."""
    rolls = sorted(Path(out).glob("roll_*.npz"))
    if not rolls:
        raise FileNotFoundError(f"no rollouts in {out}")
    rgb, lid, tel, ctl, pairs = [], [], [], [], []
    offset = 0
    for r in rolls:
        d = np.load(r)
        T = d["rgb"].shape[0]
        rgb.append(d["rgb"]); lid.append(d["lidar"]); tel.append(d["telemetry"]); ctl.append(d["control"])
        for t in range(T - 1):
            pairs.append((offset + t, offset + t + 1))
        offset += T
    return (np.concatenate(rgb), np.concatenate(lid), np.concatenate(tel),
            np.concatenate(ctl), np.asarray(pairs, dtype=np.int64))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.drive.collect")
    ap.add_argument("--rollouts", type=int, default=40)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--out", default="ml/data/drive_pool")
    args = ap.parse_args(argv)
    n = prepare_pool(args.rollouts, args.steps, args.out)
    return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
