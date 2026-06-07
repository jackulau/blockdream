"""train_real.py + serve.load_real_checkpoint on a tiny synthetic dataset
(no network) — covers the real-data training + serving code paths fast."""

from __future__ import annotations

import numpy as np
import torch

from blockdream_wm import train_real
from blockdream_wm.serve import load_real_checkpoint


def test_train_real_then_serve(tmp_path):
    # tiny synthetic "frames + actions" in the prepare_vpt output format
    T, S = 10, 32
    rng = np.random.default_rng(0)
    frames = (rng.integers(0, 255, size=(T, S, S, 3))).astype(np.uint8)
    actions = np.zeros((T, 11), dtype=np.float32)
    actions[:, 0] = 1.0  # "forward" held
    data = tmp_path / "data"
    data.mkdir()
    np.save(data / "frames.npy", frames)
    np.save(data / "actions.npy", actions)

    ckpt = tmp_path / "vpt.pt"
    rc = train_real.main(["--data", str(data), "--steps", "4", "--tok-steps", "4", "--batch", "6", "--out", str(ckpt)])
    assert rc == 0
    assert ckpt.exists()

    # the server can load the real checkpoint and generate a frame
    session = load_real_checkpoint(str(ckpt))
    assert session.size == S
    session.reset()  # seeded from the saved init frame
    res = session.step(torch.tensor([1.0, 0, 0, 0, 0, 0, 0, 0, 0]), torch.zeros(2))
    assert res.frame.shape == (3, S, S)
    assert torch.isfinite(res.frame).all()
