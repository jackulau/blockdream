"""Real commaVQ driving path: pose→(control,telemetry) derivation, real-pool build/load round-trip,
and a no-LiDAR DriveTransition train-step smoke. Uses a commaVQ-SHAPED fixture (a known left/right
curving ego trajectory) so we can assert DIRECTIONAL correctness — no multi-GB download, no synthetic
TRAINING data (the served model trains on real commaVQ; this only exercises the code paths)."""

from __future__ import annotations

import numpy as np
import torch

from blockdream_wm.config import DynamicsConfig
from blockdream_wm.drive.transition import DriveTransition
from blockdream_wm.drive.commavq import (
    real_control_and_telemetry, build_real_pool, load_real_token_pool, load_real_token_windows,
    TOKENS_PER_FRAME, COMMAVQ_CODEBOOK,
)


def _curving_pose(T=120, dyaw=+0.02, accel=0.0006, x0_speed=0.5) -> np.ndarray:
    """Real-shaped ego pose [x,y,z,yaw]: constant-sign turn (dyaw/frame) while speeding up."""
    yaw = np.cumsum(np.full(T, dyaw))
    speed = x0_speed + accel * np.arange(T)          # forward speed ramps up
    dx, dy = speed * np.cos(yaw), speed * np.sin(yaw)
    x, y = np.cumsum(dx), np.cumsum(dy)
    z = np.zeros(T)
    return np.stack([x, y, z, yaw], axis=1).astype(np.float32)


def _fixture_segment(tmp_path, dyaw=+0.02, T=120):
    rng = np.random.default_rng(0)
    tok = rng.integers(0, COMMAVQ_CODEBOOK, (T, 8, 16)).astype(np.int16)
    pose = _curving_pose(T, dyaw=dyaw)
    np.save(tmp_path / "token.npy", tok)
    np.save(tmp_path / "pose.npy", pose)
    return str(tmp_path / "token.npy"), str(tmp_path / "pose.npy")


def test_real_control_and_telemetry_layout_and_direction():
    # LEFT turn (yaw increasing) → steer > 0 and telemetry yaw-rate (ch2) > 0
    pose_l = _curving_pose(dyaw=+0.02)
    ctrl_l, tel_l = real_control_and_telemetry(pose_l)
    assert ctrl_l.shape == (len(pose_l), 3) and tel_l.shape == (len(pose_l), 6)
    assert ctrl_l[:, 0].mean() > 0.05, "left turn should give positive steer"
    assert tel_l[:, 2].mean() > 0.0, "left turn should give positive telemetry yaw-rate (ch2)"

    # RIGHT turn (yaw decreasing) → steer < 0 and telemetry yaw-rate < 0 (steer responds to direction)
    pose_r = _curving_pose(dyaw=-0.02)
    ctrl_r, tel_r = real_control_and_telemetry(pose_r)
    assert ctrl_r[:, 0].mean() < -0.05
    assert tel_l[:, 2].mean() > tel_r[:, 2].mean(), "left yaw-rate must exceed right (eval_drive_control's gate)"

    # telemetry physical: speed channel (ch3) in [0, 1.5] → *30 stays in a sane 0..45 m/s band
    assert tel_l[:, 3].min() >= 0.0 and tel_l[:, 3].max() <= 1.5
    # throttle (real speed demand) correlates with telemetry speed (both real-pose-derived, aligned)
    corr = np.corrcoef(ctrl_l[:, 1], tel_l[:, 3])[0, 1]
    assert corr > 0.5, f"throttle should track telemetry speed (corr={corr:.2f})"


def test_build_and_load_real_pool_roundtrip(tmp_path):
    seg_dir = tmp_path / "seg0"
    seg_dir.mkdir()
    tok_npy, pose_npy = _fixture_segment(seg_dir, T=120)
    out = tmp_path / "drive_real_pool"
    n = build_real_pool([(tok_npy, pose_npy)], str(out))
    assert n == 1
    assert (out / "source.txt").read_text() == "commavq-real"

    tokens, ctl, tel, pairs = load_real_token_pool(str(out))
    assert tokens.shape[1] == TOKENS_PER_FRAME
    assert ctl.shape[1] == 3 and tel.shape[1] == 6
    assert tokens.shape[0] == tel.shape[0] == ctl.shape[0]
    assert len(pairs) == tokens.shape[0] - 1            # consecutive pairs within the one rollout
    assert tokens.max() < COMMAVQ_CODEBOOK and tokens.min() >= 0

    windows = load_real_token_windows(str(out), k=8)
    assert windows.shape[1] == 9 and len(windows) > 0


def test_no_lidar_transition_train_step_is_finite(tmp_path):
    """The real model is DriveTransition with n_lidar=0; loss + rollout_loss must be finite
    (the empty-LiDAR mse guard) so training doesn't NaN out."""
    seg_dir = tmp_path / "seg0"
    seg_dir.mkdir()
    tok_npy, pose_npy = _fixture_segment(seg_dir, T=80)
    out = tmp_path / "pool"
    build_real_pool([(tok_npy, pose_npy)], str(out))
    tokens, ctl, tel, pairs = load_real_token_pool(str(out))

    dev = torch.device("cpu")
    trans = DriveTransition(DynamicsConfig(kind="ar", dim=64, depth=2, heads=4),
                            n_tokens=TOKENS_PER_FRAME, codebook_size=COMMAVQ_CODEBOOK,
                            n_lidar=0, n_telemetry=6).to(dev)
    tok_t = torch.from_numpy(tokens).long()
    ctl_t = torch.from_numpy(ctl).float()
    tel_t = torch.from_numpy(tel).float()
    empty_lidar = torch.zeros((tokens.shape[0], 0))

    b = pairs[:8]
    i0 = torch.from_numpy(b[:, 0]); i1 = torch.from_numpy(b[:, 1])
    loss, parts = trans.loss(tok_t[i0], tok_t[i1], empty_lidar[i0], tel_t[i0], ctl_t[i0],
                             empty_lidar[i1], tel_t[i1])
    assert torch.isfinite(loss), f"loss not finite: {loss}"
    assert parts["lidar"] == 0.0, "no-LiDAR path must contribute zero lidar loss"

    # recursive rollout loss on the telemetry feedback path (K windows), n_lidar=0
    win = load_real_token_windows(str(out), k=6)
    w = torch.from_numpy(win[:8])
    rloss, rparts = trans.rollout_loss(tel_t[w[:, 0]], empty_lidar[w[:, 0]],
                                       ctl_t[w[:, :-1]], tel_t[w[:, 1:]], None)
    assert torch.isfinite(rloss), f"rollout loss not finite: {rloss}"
    assert rparts["roll_lidar"] == 0.0


def test_build_real_pool_requires_pose(tmp_path):
    rng = np.random.default_rng(0)
    np.save(tmp_path / "token.npy", rng.integers(0, COMMAVQ_CODEBOOK, (20, 8, 16)).astype(np.int16))
    try:
        build_real_pool([(str(tmp_path / "token.npy"), None)], str(tmp_path / "pool"))
        assert False, "should refuse to build a real pool without ego pose"
    except ValueError:
        pass
