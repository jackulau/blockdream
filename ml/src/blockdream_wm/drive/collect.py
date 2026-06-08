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


def _cruise_action(sim: DriveSim, rng: np.random.Generator, throttle_hold: float) -> tuple[float, float, float]:
    """Pursuit STEERING but an OPEN-LOOP throttle held at a fixed level (no speed regulation). Across
    rollouts this makes the car settle at DIFFERENT speeds for different throttle holds, giving the
    model a causal throttle→cruise-speed signal the speed-regulated pursuit autopilot erases."""
    cl = sim.centerline
    car = np.array([sim.state.x, sim.state.y])
    i = int(np.argmin(((cl - car) ** 2).sum(1)))
    ego = sim._to_ego(cl[(i + 6) % len(cl)][None])[0]
    steer = float(np.clip(1.6 * math.atan2(ego[1], ego[0]), -1, 1)) + float(rng.normal(0, 0.05))
    return float(np.clip(steer, -1, 1)), float(np.clip(throttle_hold + rng.normal(0, 0.03), 0, 1)), 0.0


def collect_rollout(steps: int, seed: int, cfg: DriveConfig | None = None,
                    target_speed: float = 11.0, mode: str = "pursuit", throttle_hold: float = 0.5) -> dict:
    sim = DriveSim(cfg, seed=seed)
    rng = np.random.default_rng(seed + 1)
    sim.reset()
    rgb, lidar, tel, ctrl = [], [], [], []
    for _ in range(steps):
        obs = sim.observation()
        a = _cruise_action(sim, rng, throttle_hold) if mode == "cruise" else _pursuit_action(sim, rng, target_speed)
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
        # Diversify SPEED so the model learns throttle→speed (not a fixed ~11 m/s attractor): half the
        # rollouts regulate to a target spanning 5..23 m/s, half hold an open-loop throttle spanning
        # 0..1 (settling at the matching cruise speed). Both span steering via the pursuit lookahead.
        if i % 2 == 0:
            target = 5.0 + 18.0 * ((i // 2) % 6) / 5.0
            r = collect_rollout(steps, seed + i, DriveConfig(track=track), target_speed=target, mode="pursuit")
            tag = f"pursuit@{target:.0f}m/s"
        else:
            hold = ((i // 2) % 6) / 5.0
            r = collect_rollout(steps, seed + i, DriveConfig(track=track), mode="cruise", throttle_hold=hold)
            tag = f"cruise@thr{hold:.1f}"
        np.savez_compressed(f, **r)
        print(f"[drive.collect] {i + 1}/{rollouts}: {steps} steps ({track}, {tag})")
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


def load_windows(out: str, k: int) -> np.ndarray:
    """→ windows (W, k+1) of GLOBAL frame indices, each k+1 consecutive frames within a SINGLE
    rollout (no window straddles a rollout boundary). Feeds the multi-step recursive rollout loss."""
    rolls = sorted(Path(out).glob("roll_*.npz"))
    if not rolls:
        raise FileNotFoundError(f"no rollouts in {out}")
    windows = []
    offset = 0
    for r in rolls:
        T = int(np.load(r)["rgb"].shape[0])
        for t in range(T - k):
            windows.append(list(range(offset + t, offset + t + k + 1)))
        offset += T
    if not windows:
        raise ValueError(f"rollouts in {out} too short for window length k={k}")
    return np.asarray(windows, dtype=np.int64)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.drive.collect")
    ap.add_argument("--rollouts", type=int, default=40)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--out", default="ml/data/drive_pool")
    args = ap.parse_args(argv)
    n = prepare_pool(args.rollouts, args.steps, args.out)
    return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
