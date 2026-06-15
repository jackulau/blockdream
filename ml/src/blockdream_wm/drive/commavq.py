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


def _heading(pose: np.ndarray) -> np.ndarray:
    """Per-frame heading (rad) from REAL ego pose: an explicit yaw column if present, else atan2 of
    the position-delta (direction of travel). All real — derived from comma's logged ego trajectory."""
    p = np.asarray(pose, dtype=np.float64)
    if p.shape[1] >= 4:                     # commaVQ pose often carries an orientation triple
        return np.asarray(p[:, 3], dtype=np.float64)
    pos = p[:, :2]
    d = np.diff(pos, axis=0)
    head = np.arctan2(d[:, 1], d[:, 0])
    return np.r_[head[:1], head] if len(head) else np.zeros(len(p))


def real_control_and_telemetry(pose: np.ndarray, speed_units_per_mps: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Derive ALIGNED (control, telemetry) from REAL comma ego pose — zero synthesis.

    control  (T,3) = [steer, throttle, brake]   (model INPUT)
    telemetry(T,6) = [vx/30, vy/15, yaw_rate, speed/30, sin(yaw), cos(yaw)]   (model OUTPUT/HUD,
                     same channel layout as the sim model so serve + eval_drive_control read it
                     unchanged: tel[3]*30 = speed m/s, tel[2] = yaw-rate)

    Control is the real driving DEMAND read off the trajectory (steer = real yaw command, throttle =
    real forward-speed demand, brake = real deceleration); telemetry is the real resulting state. They
    are aligned (both from the same real pose) so the world model learns a clean, real control→state
    map — no fabricated correlations. Normalisation is per-segment robust (95th pct) → unit-free, which
    is the honest choice since commaVQ ships no metric scale (use comma2k19 CAN for true SI units)."""
    p = np.asarray(pose, dtype=np.float64)
    T = p.shape[0]
    pos = p[:, :2] if p.shape[1] >= 2 else np.zeros((T, 2))
    speed_raw = np.r_[0.0, np.linalg.norm(np.diff(pos, axis=0), axis=1)]          # real frame speed
    head = _heading(p)
    dyaw = np.diff(head)
    dyaw = np.arctan2(np.sin(dyaw), np.cos(dyaw))                                  # wrap to (−π,π]
    yaw_rate_raw = np.r_[0.0, dyaw]                                                # real heading rate
    accel_raw = np.r_[0.0, np.diff(speed_raw)]

    def _robust(x, lo, hi):
        s = np.percentile(np.abs(x), 95) + 1e-9
        return np.clip(x / s, lo, hi)

    sp = _robust(speed_raw, 0.0, 1.5)          # normalized forward speed (real)
    yr = _robust(yaw_rate_raw, -1.0, 1.0)      # normalized yaw rate (real)
    dec = _robust(np.clip(-accel_raw, 0, None), 0.0, 1.0)

    ctrl = np.zeros((T, 3), dtype=np.float32)
    ctrl[:, 0] = yr                            # steer  = real yaw command
    ctrl[:, 1] = np.clip(sp, 0.0, 1.0)         # throttle = real forward-speed demand
    ctrl[:, 2] = dec                           # brake  = real deceleration

    speed_n = (sp * 0.5).astype(np.float32)    # tel[3]: speed/30 band → *30 ≈ 0..22 m/s
    yaw_tel = (yr * 0.3).astype(np.float32)    # tel[2]: yaw-rate band
    tel = np.zeros((T, 6), dtype=np.float32)
    tel[:, 0] = speed_n                        # vx/30 ≈ forward speed
    tel[:, 1] = 0.0                            # vy/15 (no lateral-velocity channel in commaVQ pose)
    tel[:, 2] = yaw_tel                        # yaw-rate
    tel[:, 3] = speed_n                        # speed/30
    tel[:, 4] = np.sin(head).astype(np.float32)
    tel[:, 5] = np.cos(head).astype(np.float32)
    return ctrl, tel


def build_real_pool(segments: list[tuple[str, str | None]], out_dir: str,
                    max_frames_per_seg: int = 0) -> int:
    """Build a REAL driving token pool from commaVQ segments → roll_*.npz {tokens,control,telemetry}.

    `segments` = list of (token_npy, pose_npy) paths. Writes one rollout per segment plus a
    `source.txt` provenance marker ('commavq-real'). Returns the number of rollouts written.
    This is the driving analogue of import_mineflayer.py: REAL footage in, no synthetic stand-ins."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "source.txt").write_text("commavq-real")
    written = 0
    for i, (tok_npy, pose_npy) in enumerate(segments):
        f = out / f"roll_{i:05d}.npz"
        if f.exists():
            written += 1
            continue
        tokens, pose = load_segment(tok_npy, pose_npy)
        if pose is None:
            raise ValueError(f"segment {tok_npy} has no pose → cannot derive real control; skip it")
        if max_frames_per_seg and tokens.shape[0] > max_frames_per_seg:
            tokens, pose = tokens[:max_frames_per_seg], pose[:max_frames_per_seg]
        T = min(tokens.shape[0], pose.shape[0])
        ctrl, tel = real_control_and_telemetry(pose[:T])
        np.savez_compressed(f, tokens=tokens[:T].astype(np.int64),
                            control=ctrl, telemetry=tel)
        written += 1
        print(f"[commavq.build_real_pool] {i + 1}/{len(segments)}: {T} real frames @128 tokens → {f.name}")
    n = len(list(out.glob("roll_*.npz")))
    print(f"[commavq.build_real_pool] {n} REAL commaVQ rollouts in {out}")
    return n


def load_real_token_pool(out: str):
    """→ (tokens (N,128) int64, control (N,3) f32, telemetry (N,6) f32, pairs (P,2) int64)."""
    rolls = sorted(Path(out).glob("roll_*.npz"))
    if not rolls:
        raise FileNotFoundError(f"no commaVQ rollouts in {out}")
    tok, ctl, tel, pairs = [], [], [], []
    offset = 0
    for r in rolls:
        d = np.load(r)
        T = d["tokens"].shape[0]
        tok.append(d["tokens"]); ctl.append(d["control"]); tel.append(d["telemetry"])
        for t in range(T - 1):
            pairs.append((offset + t, offset + t + 1))
        offset += T
    return (np.concatenate(tok), np.concatenate(ctl), np.concatenate(tel),
            np.asarray(pairs, dtype=np.int64))


def load_real_token_windows(out: str, k: int) -> np.ndarray:
    """→ windows (W, k+1) of GLOBAL frame indices, k+1 consecutive frames within ONE rollout."""
    rolls = sorted(Path(out).glob("roll_*.npz"))
    if not rolls:
        raise FileNotFoundError(f"no commaVQ rollouts in {out}")
    windows, offset = [], 0
    for r in rolls:
        T = int(np.load(r)["tokens"].shape[0])
        for t in range(T - k):
            windows.append(list(range(offset + t, offset + t + k + 1)))
        offset += T
    if not windows:
        raise ValueError(f"commaVQ rollouts in {out} too short for window length k={k}")
    return np.asarray(windows, dtype=np.int64)
