"""Unit tests for eval_drive_quality's pure helpers — no checkpoint, no model, fast."""

import importlib.util
import math
import sys
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval_drive_quality.py"
spec = importlib.util.spec_from_file_location("eval_drive_quality", SCRIPT)
edq = importlib.util.module_from_spec(spec)
sys.modules["eval_drive_quality"] = edq
spec.loader.exec_module(edq)


def test_telemetry_carstate_roundtrip():
    # telemetry -> CarState -> telemetry is the identity (position aside)
    tel = np.array([12.0 / 30, -1.5 / 15, 0.4, math.hypot(12.0, -1.5) / 30,
                    math.sin(0.7), math.cos(0.7)], dtype=np.float32)
    s = edq.telemetry_to_carstate(tel)
    assert abs(s.vx - 12.0) < 1e-5 and abs(s.vy + 1.5) < 1e-5
    assert abs(s.r - 0.4) < 1e-6 and abs(s.yaw - 0.7) < 1e-6
    back = edq.carstate_to_telemetry(s)
    assert np.allclose(back, tel, atol=1e-5)


def test_control_schedule_phases_and_bounds():
    sched = edq.control_schedule(48)
    assert len(sched) == 48
    for steer, throttle, brake in sched:
        assert -1.0 <= steer <= 1.0 and 0.0 <= throttle <= 1.0 and 0.0 <= brake <= 1.0
    # all four phases present: accelerate, left, right, brake
    assert sched[0] == [0.0, 0.8, 0.0]
    assert any(c[0] > 0 for c in sched) and any(c[0] < 0 for c in sched)
    assert any(c[2] > 0 for c in sched)


def test_drift_mae_zero_for_identical_tracks():
    track = np.random.default_rng(0).normal(size=(20, 6)).astype(np.float32)
    speed, yaw = edq.drift_mae(track, track.copy())
    assert speed == 0.0 and yaw == 0.0


def test_drift_mae_scales_speed_to_mps():
    a = np.zeros((10, 6), dtype=np.float32)
    b = np.zeros((10, 6), dtype=np.float32)
    b[:, 3] = 0.1  # 0.1 normalized speed = 3 m/s
    b[:, 2] = 0.2  # yaw-rate raw
    speed, yaw = edq.drift_mae(a, b)
    assert abs(speed - 3.0) < 1e-6
    assert abs(yaw - 0.2) < 1e-6


def test_history_rows_layout_and_padding():
    import torch

    ctl = torch.arange(12, dtype=torch.float32).view(4, 3)   # T=4 control rows
    tel = torch.arange(24, dtype=torch.float32).view(4, 6) + 100.0
    h = edq.history_rows(ctl, tel, n_history=2)
    assert h.shape == (3, 2 * 9)
    # t=0: no past frames → all zeros
    assert torch.all(h[0] == 0)
    # t=1: oldest slot (j=-1) zero-padded, newest slot = (ctl[0], tel[0])
    assert torch.all(h[1, :9] == 0)
    assert torch.equal(h[1, 9:12], ctl[0]) and torch.equal(h[1, 12:18], tel[0])
    # t=2: slots = (ctl[0], tel[0]), (ctl[1], tel[1])
    assert torch.equal(h[2, 0:3], ctl[0]) and torch.equal(h[2, 3:9], tel[0])
    assert torch.equal(h[2, 9:12], ctl[1]) and torch.equal(h[2, 12:18], tel[1])


def test_verdict_pass_and_fail():
    thresholds = {"a": 1.0, "b": 2.0}
    ok, lines = edq.verdict({"a": 0.5, "b": 1.9}, thresholds)
    assert ok and len(lines) == 2 and all("ok" in line for line in lines)
    ok, lines = edq.verdict({"a": 1.5, "b": 1.9}, thresholds)
    assert not ok and any("FAIL" in line for line in lines)


def test_thresholds_have_headroom_over_recorded_measurements():
    # The recorded measurements in the module docstring/comment must stay below the gate
    # thresholds — guards against someone tightening a threshold under the known-good values.
    measured = {"tel_mse": 0.0021, "lidar_mse": 0.0058, "rgb_ce": 1.32,
                "drift_speed_mae": 4.32, "drift_yaw_mae": 0.158}
    ok, _ = edq.verdict(measured, edq.THRESHOLDS)
    assert ok
