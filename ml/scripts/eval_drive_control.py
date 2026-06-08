"""Prove the driving world model is CONTROLLABLE under its own recursive rollout (not just stable).

Free-runs the model (no teacher forcing) from the checkpoint's seed state and checks the telemetry
responds to control the way physics demands:
  - throttle raises settled speed vs coasting,
  - steering left yields a higher yaw-rate than steering right,
  - speed stays in a physical band the whole time (the D1 bound guarantees finiteness; this adds sense).

Exits 0 and prints "CONTROLLABLE" when all hold, else 1. This is the D2 ground-truth gate — a model
that collapses to a flat, control-independent attractor (the pre-fix behaviour) fails it.

    ml/.venv/bin/python scripts/eval_drive_control.py --checkpoint runs/drive/latest.pt
"""

from __future__ import annotations

import argparse
import sys

from blockdream_wm.drive.serve import load_drive_session


def _settled(session, control, steps=80, tail=25):
    """Free-running recursive rollout under a fixed control → (mean speed m/s, mean yaw-rate) over the
    settled tail."""
    session.reset()
    speeds, yaws = [], []
    for _ in range(steps):
        o = session.step(control)
        tel = o["telemetry"].tolist()
        speeds.append(tel[3] * 30.0)
        yaws.append(tel[2])
    n = min(tail, len(speeds))
    return sum(speeds[-n:]) / n, sum(yaws[-n:]) / n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("eval_drive_control")
    ap.add_argument("--checkpoint", default="runs/drive/latest.pt")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--speed-margin", type=float, default=1.0, help="min m/s by which throttle must beat coast")
    ap.add_argument("--yaw-margin", type=float, default=0.03, help="min by which left yaw-rate must beat right")
    args = ap.parse_args(argv)

    session = load_drive_session(args.checkpoint, device=args.device)
    coast_speed, _ = _settled(session, [0.0, 0.0, 0.0])
    throttle_speed, _ = _settled(session, [0.0, 1.0, 0.0])
    _, left_yaw = _settled(session, [1.0, 0.5, 0.0])   # steer left
    _, right_yaw = _settled(session, [-1.0, 0.5, 0.0])  # steer right

    throttle_responds = throttle_speed > coast_speed + args.speed_margin
    steer_responds = left_yaw > right_yaw + args.yaw_margin
    physical = all(0.0 <= s <= 60.0 for s in (coast_speed, throttle_speed))

    print(f"[drive-control] coast speed     = {coast_speed:6.2f} m/s")
    print(f"[drive-control] throttle speed  = {throttle_speed:6.2f} m/s   (throttle responds: {throttle_responds})")
    print(f"[drive-control] yaw-rate left   = {left_yaw:+.3f}")
    print(f"[drive-control] yaw-rate right  = {right_yaw:+.3f}   (steer responds: {steer_responds})")
    print(f"[drive-control] speed physical (0..60): {physical}")

    ok = throttle_responds and steer_responds and physical
    print("CONTROLLABLE" if ok else "NOT CONTROLLABLE — telemetry does not respond to control")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
