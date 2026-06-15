"""Quality gate for the SERVED driving world model checkpoint (runs/drive/latest.pt).

Two honest paths, auto-selected from the checkpoint's `real_source`:

REAL (commaVQ camera-only, the served model) - measures what the browser tester experiences on the
real model: one-step RGB next-token CE + telemetry MSE on a REAL commaVQ holdout (predicts real
frames far better than chance?), controllability (throttle raises speed, steer left≠right, speed
physical), and free-run stability (telemetry finite + tokens in codebook range). NO LiDAR / physics /
multi-track - commaVQ has none, so a sim-shaped gate would be dishonest here.

SIM (deprecated physics-sim checkpoint) - the original multi-track gate: per-modality one-step val on
fresh sim rollouts + closed-loop drift vs the physics ground truth.

Prints [drive-quality] diagnostics, then ONE verdict word - QUALITY_OK / QUALITY_FAIL - and
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

from blockdream_wm.drive.serve import load_drive_session
# NB: the sim modules (collect/physics/sim) are the DEPRECATED synthetic path - imported lazily in
# the SIM branch only, so the REAL (commaVQ) gate has zero dependency on synthetic code.

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


def telemetry_to_carstate(tel: np.ndarray):
    """Invert sim.telemetry(): [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)] → CarState.
    Position is unknowable (and irrelevant - physics has no walls), so x=y=0."""
    from blockdream_wm.drive.physics import CarState
    return CarState(
        x=0.0,
        y=0.0,
        yaw=math.atan2(float(tel[4]), float(tel[5])),
        vx=float(tel[0]) * 30.0,
        vy=float(tel[1]) * 15.0,
        r=float(tel[2]),
    )


def carstate_to_telemetry(s) -> np.ndarray:
    """sim.telemetry() for a bare CarState (same normalization)."""
    return np.array(
        [s.vx / 30, s.vy / 15, s.r, s.speed() / 30, math.sin(s.yaw), math.cos(s.yaw)],
        dtype=np.float32,
    )


def control_schedule(steps: int) -> list[list[float]]:
    """Fixed deterministic [steer, throttle, brake] schedule exercising accelerate / turn left /
    turn right / brake - the behaviours the browser tester drives."""
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


def history_rows(ctl: torch.Tensor, tel: torch.Tensor, n_history: int) -> torch.Tensor:
    """Teacher-forced flattened (control, telemetry) history windows for every prev index
    t in 0..T-2, zero-padded before the rollout start - same layout as training/serve."""
    T, n_ctl, n_tel = tel.shape[0], ctl.shape[1], tel.shape[1]
    width = n_ctl + n_tel
    out = torch.zeros((T - 1, n_history * width), dtype=tel.dtype, device=tel.device)
    for t in range(T - 1):
        for k in range(n_history, 0, -1):
            j = t - k
            if j >= 0:
                col = (n_history - k) * width
                out[t, col:col + n_ctl] = ctl[j]
                out[t, col + n_ctl:col + width] = tel[j]
    return out


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

    n_hist = getattr(trans, "n_history", 0)
    hist = history_rows(ctrl, tel, n_hist) if n_hist > 0 else None
    c = trans._fuse(ctrl[:-1], lidar[:-1], tel[:-1], hist)
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
    from blockdream_wm.drive.physics import CarParams, step as physics_step  # noqa: F811
    from blockdream_wm.drive.sim import DriveConfig
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


# REAL (commaVQ camera-only) quality bars - set from the served checkpoint's measured numbers with
# headroom. Measured on the real served model (--quick): rgb_ce 2.27 (vs random 6.93), tel_mse 0.0005.
REAL_THRESHOLDS = {
    "rgb_ce": 4.0,         # one-step next-token CE on a REAL commaVQ holdout (random = ln(1024) = 6.93)
    "tel_mse": 0.010,      # one-step telemetry MSE on the real holdout (normalized units)
}


def _real_holdout_pool():
    """Locate (or build from the committed real fixture) a REAL commaVQ holdout pool. Prefers an
    existing data/drive_real_pool; else builds a tiny pool from tests/fixtures/commavq_real so the
    gate runs on a fresh clone (the fixture is committed). Returns the pool dir or None."""
    from pathlib import Path
    from blockdream_wm.drive.commavq import build_real_pool
    ml = Path(__file__).resolve().parent.parent
    pool = ml / "data" / "drive_real_pool"
    if list(pool.glob("roll_*.npz")):
        return str(pool)
    fixture = ml / "tests" / "fixtures" / "commavq_real"
    if fixture.exists():
        import scripts.collect_real_drive as cr  # discover (token,pose) pairs in the fixture
        segs = [s for s in cr.discover_segments(fixture) if s[1]]
        if segs:
            out = ml / "data" / "drive_real_holdout"
            build_real_pool(segs, str(out))
            return str(out)
    return None


@torch.no_grad()
def real_quality(session, args, t0: float) -> int:
    """Camera-only REAL quality gate: real-holdout next-token CE + telemetry MSE, controllability,
    and free-run stability. No LiDAR / physics / multi-track (commaVQ has none)."""
    from blockdream_wm.drive.commavq import load_real_token_pool, COMMAVQ_CODEBOOK
    from eval_drive_control import _settled  # controllability rollout (reused gate)

    pool = _real_holdout_pool()
    measured: dict[str, float] = {}
    if pool is None:
        print("[drive-quality] no real holdout pool/fixture found - CE/MSE skipped (controllability still gated)")
        measured.update(rgb_ce=0.0, tel_mse=0.0)
    else:
        tok, ctl, tel, pairs = load_real_token_pool(pool)
        dev = session.device
        tk = torch.from_numpy(tok).long().to(dev); ct = torch.from_numpy(ctl).float().to(dev)
        te = torch.from_numpy(tel).float().to(dev); lid = torch.zeros((tok.shape[0], 0), device=dev)
        n = min(64 if args.quick else 256, len(pairs))
        idx = np.linspace(0, len(pairs) - 1, n).astype(np.int64)
        b = pairs[idx]; i0 = torch.from_numpy(b[:, 0]).to(dev); i1 = torch.from_numpy(b[:, 1]).to(dev)
        c = session.trans._fuse(ct[i0], lid[i0], te[i0])
        rgb_ce = session.trans.ar.loss(tk[i0], tk[i1], c).item()
        tel_mse = torch.mean((session.trans.bound_tel(session.trans.telemetry_head(c)) - te[i1]) ** 2).item()
        measured.update(rgb_ce=rgb_ce, tel_mse=tel_mse)
        print(f"[drive-quality] REAL holdout ({n} pairs): rgb_ce={rgb_ce:.3f} nats/token "
              f"(random={float(np.log(COMMAVQ_CODEBOOK)):.2f}), tel_mse={tel_mse:.5f}")

    # controllability (same checks as eval_drive_control)
    coast, _ = _settled(session, [0.0, 0.0, 0.0]); thr, _ = _settled(session, [0.0, 1.0, 0.0])
    _, lyaw = _settled(session, [1.0, 0.5, 0.0]); _, ryaw = _settled(session, [-1.0, 0.5, 0.0])
    controllable = bool(thr > coast + 1.0 and lyaw > ryaw + 0.03 and 0.0 <= coast <= 60.0 and 0.0 <= thr <= 60.0)
    print(f"[drive-quality] controllability: coast={coast:.2f} throttle={thr:.2f} m/s, "
          f"yaw L={lyaw:+.3f} R={ryaw:+.3f} → controllable={controllable}")

    # free-run stability: telemetry finite + tokens in codebook range over a recursive rollout
    session.reset(); stable = True
    for _ in range(40 if args.quick else 120):
        o = session.step([0.3, 0.6, 0.0])
        if not np.all(np.isfinite(o["telemetry"].numpy())):
            stable = False; break
    tok_ok = bool(session.tokens.min().item() >= 0 and session.tokens.max().item() < COMMAVQ_CODEBOOK)
    print(f"[drive-quality] free-run stability: telemetry_finite={stable} tokens_in_codebook={tok_ok}")

    ok, lines = verdict(measured, REAL_THRESHOLDS) if pool is not None else (True, [])
    for line in lines:
        print(f"[drive-quality] {line}")
    ok = ok and controllable and stable and tok_ok
    print(f"[drive-quality] wall-clock {time.time() - t0:.1f}s")
    if args.report_only:
        print("REPORT_ONLY"); return 0
    print("QUALITY_OK" if ok else "QUALITY_FAIL - served REAL driving checkpoint below quality bar")
    return 0 if ok else 1


def sim_quality(session, args, t0: float) -> int:
    """Original multi-track physics-sim quality gate (the DEPRECATED sim checkpoint)."""
    from blockdream_wm.drive.collect import collect_rollout
    from blockdream_wm.drive.sim import TRACK_KINDS, DriveConfig
    steps = 40 if args.quick else 150
    drift_steps = 48 if args.quick else 120
    rgb_pairs = 8 if args.quick else 32

    worst = {"tel_mse": 0.0, "lidar_mse": 0.0, "rgb_ce": 0.0}
    for k, track in enumerate(TRACK_KINDS):
        roll = collect_rollout(steps, seed=9000 + k, cfg=DriveConfig(track=track))
        err = one_step_errors(session, roll, rgb_pairs)
        print(f"[drive-quality] {track:8s} tel_mse={err['tel_mse']:.5f} "
              f"lidar_mse={err['lidar_mse']:.5f} rgb_ce={err['rgb_ce']:.3f}")
        for key in worst:
            worst[key] = max(worst[key], err[key])
    speed_mae, yaw_mae = closed_loop_drift(session, drift_steps)
    print(f"[drive-quality] closed-loop drift over {drift_steps} steps: "
          f"speed MAE={speed_mae:.2f} m/s, yaw-rate MAE={yaw_mae:.3f} rad/s")
    measured = dict(worst, drift_speed_mae=speed_mae, drift_yaw_mae=yaw_mae)
    ok, lines = verdict(measured, THRESHOLDS)
    for line in lines:
        print(f"[drive-quality] {line}")
    print(f"[drive-quality] wall-clock {time.time() - t0:.1f}s")
    if args.report_only:
        print("REPORT_ONLY"); return 0
    print("QUALITY_OK" if ok else "QUALITY_FAIL - served driving checkpoint below quality bar")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("eval_drive_quality")
    ap.add_argument("--checkpoint", default="runs/drive/latest.pt")
    ap.add_argument("--device", default="cpu")  # CPU beats MPS for sequential AR decode (see serve.py)
    ap.add_argument("--quick", action="store_true", help="reduced steps - rides verify-all (<2 min)")
    ap.add_argument("--report-only", action="store_true", help="print metrics, always exit 0")
    args = ap.parse_args(argv)

    t0 = time.time()
    session = load_drive_session(args.checkpoint, device=args.device)
    n_hist = getattr(session.trans, "n_history", 0)
    real = session.real_source == "commavq"
    print(f"[drive-quality] checkpoint {args.checkpoint} ({'REAL commaVQ' if real else 'sim'}, "
          f"n_history={n_hist})")
    return real_quality(session, args, t0) if real else sim_quality(session, args, t0)


if __name__ == "__main__":
    sys.exit(main())
