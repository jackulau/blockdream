"""Resumable long trainer: checkpoint + auto-resume continues exactly."""

from __future__ import annotations

import numpy as np
import torch

from blockdream_wm import train_long
from blockdream_wm.data_pool import load_pool
from blockdream_wm.serve import load_real_checkpoint


def _tiny_pool(d, n_seg=2, T=6, S=32, seed=0):
    rng = np.random.default_rng(seed)
    d.mkdir(parents=True, exist_ok=True)
    for i in range(n_seg):
        frames = rng.integers(0, 255, size=(T, S, S, 3)).astype(np.uint8)
        actions = np.zeros((T, 11), dtype=np.float32)
        actions[:, 0] = 1.0
        np.savez_compressed(d / f"seg_{i:05d}.npz", frames=frames, actions=actions)


def test_pool_pairs_are_within_segment(tmp_path):
    pool = tmp_path / "pool"
    _tiny_pool(pool, n_seg=2, T=6)
    frames, actions, pairs = load_pool(str(pool))
    assert frames.shape[0] == 12 and actions.shape == (12, 11)
    # 2 segments × (6-1) consecutive pairs = 10; none cross the seg boundary (5↔6)
    assert len(pairs) == 10
    assert not any(p[0] == 5 and p[1] == 6 for p in pairs)


def test_checkpoint_then_resume_continues(tmp_path):
    pool = tmp_path / "pool"
    _tiny_pool(pool, n_seg=2, T=6)
    out = tmp_path / "run"

    base = ["--pool", str(pool), "--out", str(out), "--preset", "quick", "--device", "cpu",
            "--batch", "4", "--ckpt-every-min", "0"]
    # run 1: finish a couple tok + ar steps
    rc = train_long.main(base + ["--tok-steps", "2", "--ar-steps", "2"])
    assert rc == 0
    assert (out / "latest.pt").exists()
    assert (out / "log.csv").exists()
    assert any((out / "samples").glob("*.png"))
    ck1 = torch.load(out / "latest.pt", map_location="cpu", weights_only=False)
    assert ck1["phase"] == "ar" and ck1["ar_step"] == 2

    # run 2: same out → resumes from ar_step=2 and continues to 5
    rc = train_long.main(base + ["--tok-steps", "2", "--ar-steps", "5"])
    assert rc == 0
    ck2 = torch.load(out / "latest.pt", map_location="cpu", weights_only=False)
    assert ck2["ar_step"] == 5  # continued, did not restart

    # the checkpoint is serve-loadable (carries tokenizer/action/transition + init_frame)
    session = load_real_checkpoint(str(out / "latest.pt"))
    session.reset()
    res = session.step(torch.tensor([1.0, 0, 0, 0, 0, 0, 0, 0, 0]), torch.zeros(2))
    assert res.frame.shape == (3, 32, 32) and torch.isfinite(res.frame).all()
