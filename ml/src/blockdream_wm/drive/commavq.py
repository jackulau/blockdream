"""Loader for commaVQ (`commaai/commavq`) — ~100k segments of REAL driving video,
pre-tokenized with comma's VQ-VAE (128 tokens/frame) + ego pose. The RGB latent
stage is already done, so it's an ideal small testbed for the recursive AR
transition (and the in-browser rollout) on real driving — no LiDAR.

Download a shard:
    huggingface-cli download commaai/commavq --repo-type dataset \
        --include 'data_0_to_2500/*' --local-dir ./commavq

Each segment: token.npy (1200, 8, 16) int16 → 1200 frames × 128 tokens;
pose.npy (1200, K) ego pose. Pseudo-control is derived from pose deltas (yaw rate
≈ steering, forward speed ≈ throttle) since commaVQ has no raw steering/pedal.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

TOKENS_PER_FRAME = 128  # 8 × 16
COMMAVQ_CODEBOOK = 1024  # comma's VQ-VAE codebook size


def load_segment(token_npy: str, pose_npy: str | None = None) -> tuple[np.ndarray, np.ndarray | None]:
    """→ (tokens (T, 128) int, pose (T, K) or None)."""
    tok = np.load(token_npy)
    tokens = tok.reshape(tok.shape[0], -1).astype(np.int64)  # (T, 128)
    pose = np.load(pose_npy) if pose_npy and Path(pose_npy).exists() else None
    return tokens, pose


def pseudo_control(pose: np.ndarray) -> np.ndarray:
    """Derive [steer, throttle, brake]-like control from ego pose deltas.
    pose columns are assumed [..., yaw, ...]; we use frame-to-frame deltas of
    position magnitude (→ throttle/brake) and heading (→ steer). Approximate —
    use comma2k19 CAN for true steering if you need it."""
    p = np.asarray(pose, dtype=np.float64)
    n = p.shape[0]
    ctrl = np.zeros((n, 3), dtype=np.float32)
    if p.shape[1] >= 3:
        # crude: position delta magnitude as speed proxy, its change as throttle/brake
        pos = p[:, :2] if p.shape[1] >= 2 else p[:, :1]
        speed = np.r_[0.0, np.linalg.norm(np.diff(pos, axis=0), axis=1)]
        accel = np.r_[0.0, np.diff(speed)]
        ctrl[:, 1] = np.clip(accel, 0, None)            # throttle ∝ +accel
        ctrl[:, 2] = np.clip(-accel, 0, None)           # brake ∝ −accel
        yaw_col = min(2, p.shape[1] - 1)
        ctrl[:, 0] = np.r_[0.0, np.diff(p[:, yaw_col])].astype(np.float32)  # steer ∝ heading rate
    # normalize to ~[-1,1]
    for k in range(3):
        m = np.abs(ctrl[:, k]).max()
        if m > 1e-6:
            ctrl[:, k] = ctrl[:, k] / m
    return ctrl
