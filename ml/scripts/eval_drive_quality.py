"""Quality gate for the SERVED driving world model checkpoint (runs/drive/latest.pt).

Unlike eval_drive.py (trains throwaway scratch models to validate the recipe), this loads the
real served checkpoint and measures what the browser tester actually experiences:

  1. one-step validation error per modality (telemetry MSE, LiDAR MSE, RGB token CE) on fresh
     sim rollouts, per track kind — multi-track generalization, not just the oval;
  2. closed-loop drift: free-run the model recursively under a fixed control schedule and
     compare its telemetry against the wall-free physics ground truth started from the same
     state (telemetry dynamics are position-independent, so this is exact).

Prints [drive-quality] diagnostics, then ONE verdict word — QUALITY_OK / QUALITY_FAIL — and
exits 0/1. --report-only always exits 0 (measurement decoupled from gating). --quick keeps the
whole run under ~2 min on CPU/MPS so it can ride scripts/verify-all.sh.

    ml/.venv/bin/python scripts/eval_drive_quality.py --checkpoint runs/drive/latest.pt --quick
"""

from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import torch

from blockdream_wm.drive.collect import collect_rollout
from blockdream_wm.drive.physics import CarParams, CarState, step as physics_step
from blockdream_wm.drive.serve import load_drive_session
from blockdream_wm.drive.sim import TRACK_KINDS, DriveConfig

# Gate thresholds, set from the shipped checkpoint's measured numbers with headroom so a
# healthy model passes across CPU/MPS nondeterminism but a collapsed/regressed one fails.
# Measured on runs/drive/latest.pt (2026-06-10, --quick): worst-track tel MSE 0.0021,
# lidar MSE 0.0058, rgb CE 1.32, drift speed MAE 4.32 m/s, drift yaw-rate MAE 0.158 rad/s.
THRESHOLDS = {
    "tel_mse": 0.012,        # worst-track one-step telemetry MSE (normalized units)
    "lidar_mse": 0.012,      # worst-track one-step LiDAR MSE (normalized [0,1] ranges)
    "rgb_ce": 2.5,           # worst-track next-token cross-entropy (nats/token)
    "drift_speed_mae": 6.0,  # closed-loop speed MAE vs physics (m/s) over the schedule
    "drift_yaw_mae": 0.45,   # closed-loop yaw-rate MAE vs physics (rad/s)
}


def telemetry_to_carstate(tel: np.ndarray) -> CarState:
    """Invert sim.telemetry(): [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)] → CarState.
    Position is unknowable (and irrelevant — physics has no walls), so x=y=0."""
    return CarState(
        x=0.0,
        y=0.0,
        yaw=math.atan2(float(tel[4]), float(tel[5])),
        vx=float(tel[0]) * 30.0,
        vy=float(tel[1]) * 15.0,
        r=float(tel[2]),
    )


def carstate_to_telemetry(s: CarState) -> np.ndarray:
    """sim.telemetry() for a bare CarState (same normalization)."""
    return np.array(
        [s.vx / 30, s.vy / 15, s.r, s.speed() / 30, math.sin(s.yaw), math.cos(s.yaw)],
        dtype=np.float32,
    )


def control_schedule(steps: int) -> list[list[float]]:
    """Fixed deterministic [steer, throttle, brake] schedule exercising accelerate / turn left /
    turn right / brake — the behaviours the browser tester drives."""
    out = []
    for t in range(steps):
        phase = (4 * t) // steps
        if phase == 0:
            out.append([0.0, 0.8, 0.0])   # accelerate straight
        elif phase == 1:
            out.append([0.6, 0.5, 0.0])   # sweep left
        elif phase == 2:
            out.append([-0.6, 0.5, 0.0])  # sweep right
        else:
            out.append([0.0, 0.0, 0.6])   # brake to a crawl
    return out


def drift_mae(model_tel: np.ndarray, phys_tel: np.ndarray) -> tuple[float, float]:
    """(speed MAE in m/s, yaw-rate MAE in rad/s) between two (T,6) normalized telemetry tracks."""
    speed = np.abs(model_tel[:, 3] - phys_tel[:, 3]).mean() * 30.0
    yaw = np.abs(model_tel[:, 2] - phys_tel[:, 2]).mean()
    return float(speed), float(yaw)


def verdict(measured: dict[str, float], thresholds: dict[str, float]) -> tuple[bool, list[str]]:
    """Compare measured metrics against thresholds → (all_ok, per-metric report lines)."""
    lines, ok = [], True
    for key, limit in thresholds.items():
        got = measured[key]
        passed = got <= limit
        ok = ok and passed
        lines.append(f"{key:16s} = {got:8.4f}  (limit {limit:g})  {'ok' if passed else 'FAIL'}")
    return ok, lines


@torch.no_grad()
def one_step_errors(session, roll: dict, rgb_pairs: int) -> dict[str, float]:
    """One-step validation error of each modality on a collected rollout (teacher-forced)."""
    dev = session.device
    tel = torch.from_numpy(roll["telemetry"]).to(dev)
    lidar = torch.from_numpy(roll["lidar"]).to(dev)
    ctrl = torch.from_numpy(roll["control"]).to(dev)
    trans = session.trans

    c = trans._fuse(ctrl[:-1], lidar[:-1], tel[:-1])
    pred_tel = trans.bound_tel(trans.telemetry_head(c))
    pred_lidar = torch.sigmoid(trans.lidar_head(c))
    tel_mse = torch.mean((pred_tel - tel[1:]) ** 2).item()
    lidar_mse = torch.mean((pred_lidar - lidar[1:]) ** 2).item()

    # RGB next-token CE on a subsample of frame pairs (AR loss over all pairs is too slow for --quick)
    frames = torch.from_numpy(roll["rgb"]).to(dev).float() / 255.0
    tokens = session.tok.tokenize(frames).view(frames.shape[0], -1)
    n_pairs = tokens.shape[0] - 1
    idx = np.linspace(0, n_pairs - 1, num=min(rgb_pairs, n_pairs), dtype=np.int64)
    i = torch.from_numpy(idx).to(dev)
    rgb_ce = trans.ar.loss(tokens[i], tokens[i + 1], c[i]).item()

    return {"tel_mse": tel_mse, "lidar_mse": lidar_mse, "rgb_ce": rgb_ce}


@torch.no_grad()
def closed_loop_drift(session, steps: int) -> tuple[float, float]:
    """Free-run the model under control_schedule() and compare its telemetry against the
    physics ground truth integrated from the model's own start state."""
    session.reset()
    start = session.tel[0].cpu().numpy()
    state = telemetry_to_carstate(start)
    params = CarParams()
    dt = DriveConfig().dt

    model_track, phys_track = [], []
    for control in control_schedule(steps):
        o = session.step(control)
        state = physics_step(state, control[0], control[1], control[2], params, dt)
        model_track.append(o["telemetry"].numpy())
        phys_track.append(carstate_to_telemetry(state))
    return drift_mae(np.stack(model_track), np.stack(phys_track))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("eval_drive_quality")
    ap.add_argument("--checkpoint", default="runs/drive/latest.pt")
    ap.add_argument("--device", default="cpu")  # CPU beats MPS for sequential AR decode (see serve.py)
    ap.add_argument("--quick", action="store_true", help="reduced steps — rides verify-all (<2 min)")
    ap.add_argument("--report-only", action="store_true", help="print metrics, always exit 0")
    args = ap.parse_args(argv)

    t0 = time.time()
    steps = 40 if args.quick else 150
    drift_steps = 48 if args.quick else 120
    rgb_pairs = 8 if args.quick else 32

    session = load_drive_session(args.checkpoint, device=args.device)
    n_hist = getattr(session.trans, "n_history", 0)
    print(f"[drive-quality] checkpoint {args.checkpoint} (n_history={n_hist}, "
          f"{session.grid * session.grid} tokens/frame)")

    # 1. one-step val error per track kind (fresh rollouts, eval-only seed ≠ training seeds)
    worst = {"tel_mse": 0.0, "lidar_mse": 0.0, "rgb_ce": 0.0}
    for k, track in enumerate(TRACK_KINDS):
        roll = collect_rollout(steps, seed=9000 + k, cfg=DriveConfig(track=track))
        err = one_step_errors(session, roll, rgb_pairs)
        print(f"[drive-quality] {track:8s} tel_mse={err['tel_mse']:.5f} "
              f"lidar_mse={err['lidar_mse']:.5f} rgb_ce={err['rgb_ce']:.3f}")
        for key in worst:
            worst[key] = max(worst[key], err[key])

    # 2. closed-loop drift vs physics ground truth
    speed_mae, yaw_mae = closed_loop_drift(session, drift_steps)
    print(f"[drive-quality] closed-loop drift over {drift_steps} steps: "
          f"speed MAE={speed_mae:.2f} m/s, yaw-rate MAE={yaw_mae:.3f} rad/s")

    measured = dict(worst, drift_speed_mae=speed_mae, drift_yaw_mae=yaw_mae)
    ok, lines = verdict(measured, THRESHOLDS)
    for line in lines:
        print(f"[drive-quality] {line}")
    print(f"[drive-quality] wall-clock {time.time() - t0:.1f}s")

    if args.report_only:
        print("REPORT_ONLY")
        return 0
    print("QUALITY_OK" if ok else "QUALITY_FAIL — served driving checkpoint below quality bar")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
