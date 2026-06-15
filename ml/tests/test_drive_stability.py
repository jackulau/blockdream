"""Recursive driving rollout must NEVER diverge. The telemetry head is fed back as prev_tel every
step; before the physical soft-clamp (DriveTransition.bound_tel) an unbounded Linear in that loop
blew up to NaN over a long rollout (reproduced: speed -4558 m/s by step 50, NaN by step 500, peak
6e36 - the browser HUD's "speed -3.5e18 m/s · yaw-rate -1.1e16"). These tests pin the fix: telemetry
stays finite and physically bounded for thousands of steps under any control, regardless of weights.
"""

from __future__ import annotations

import torch

from blockdream_wm.config import DynamicsConfig
from blockdream_wm.drive.transition import DriveTransition

# adversarial control schedule: idle, full throttle+hard steer, alternating steer, hard brake, and a
# cheap deterministic pseudo-random mix - the exact regimes that diverged in the unbounded repro.
def _control(i: int) -> list[float]:
    phase = (i // 400) % 5
    if phase == 0:
        return [0.0, 0.0, 0.0]                 # idle
    if phase == 1:
        return [1.0, 1.0, 0.0]                 # hard-left, full throttle
    if phase == 2:
        return [1.0 if (i // 7) % 2 else -1.0, 1.0, 0.0]  # alternating steer
    if phase == 3:
        return [0.0, 0.0, 1.0]                 # hard brake
    s = ((i * 1103515245 + 12345) % 2048) / 1024.0 - 1.0  # LCG pseudo-random in [-1, 1]
    return [s, abs(s), 1.0 - abs(s)]


def _model(seed: int = 0, amplify: float = 1.0) -> DriveTransition:
    torch.manual_seed(seed)
    m = DriveTransition(DynamicsConfig(kind="ar", dim=32, depth=1, heads=4),
                        n_tokens=64, codebook_size=64, n_lidar=32, n_telemetry=6)
    if amplify != 1.0:  # blow up the head so an UNBOUNDED loop would explode immediately
        with torch.no_grad():
            for p in m.telemetry_head.parameters():
                p.mul_(amplify)
    return m


def test_telemetry_recursion_cannot_diverge_over_long_rollout():
    """5000 self-fed steps under every control regime, with a deliberately amplified (×5) telemetry
    head - the bound must keep speed/yaw-rate finite + physical the whole way."""
    m = _model(amplify=5.0)
    tel = torch.zeros(1, 6)
    tel[0, 0] = tel[0, 3] = 0.4  # plausible start: ~12 m/s
    lid = torch.rand(1, 32)
    peak_speed = peak_yaw = 0.0
    for i in range(5000):
        c = m._fuse(torch.tensor([_control(i)], dtype=torch.float32), lid, tel)
        tel = m.bound_tel(m.telemetry_head(c))
        lid = torch.sigmoid(m.lidar_head(c))
        assert torch.isfinite(tel).all(), f"telemetry went non-finite at step {i}: {tel}"
        speed = abs(tel[0, 3].item()) * 30.0
        yaw = abs(tel[0, 2].item())
        peak_speed, peak_yaw = max(peak_speed, speed), max(peak_yaw, yaw)
        assert speed <= 60.0, f"speed {speed:.1f} m/s exceeds physical bound at step {i}"
        assert yaw <= 6.0, f"yaw-rate {yaw:.3f} exceeds physical bound at step {i}"
    # sanity: the bound is actually engaging (we amplified the head; values should ride near the cap)
    assert peak_speed > 1.0 and peak_yaw > 0.0


def test_bound_tel_tames_divergent_feedback():
    """Guard against silently removing the bound. An explicit expansive feedback (gain 1.5 > 1 - what
    a poorly-conditioned trained head + off-distribution rollout effectively becomes) diverges when
    unbounded but is provably tamed by bound_tel. This tests the fix's math directly, independent of
    any particular random weights."""
    m = _model()
    raw = torch.full((1, 6), 0.4)
    for _ in range(200):
        raw = 1.5 * raw  # unbounded expansive loop
    assert raw.abs().max().item() > 1e4, "control: an expansive feedback should diverge unbounded"

    bounded = torch.full((1, 6), 0.4)
    for _ in range(5000):
        bounded = m.bound_tel(1.5 * bounded)  # same loop, clamped each step
    assert torch.isfinite(bounded).all()
    assert (bounded.abs() <= m.tel_scale + 1e-4).all(), "bound_tel must keep every channel within physical scale"


def test_full_step_rollout_stays_finite():
    """Exercise the real integrated step() path (AR token gen + lidar + telemetry) for a stretch and
    confirm every modality stays finite + bounded - the actual serve code path."""
    m = _model()
    tokens = torch.randint(0, 64, (1, 64))
    lid = torch.rand(1, 32)
    tel = torch.zeros(1, 6)
    tel[0, 0] = tel[0, 3] = 0.4
    for i in range(60):
        tokens, lid, tel = m.step(tokens, lid, tel, torch.tensor([_control(i)], dtype=torch.float32))
        assert torch.isfinite(lid).all() and torch.isfinite(tel).all()
        assert tel.abs().max().item() <= 3.0 + 1e-4  # within the largest per-channel scale
