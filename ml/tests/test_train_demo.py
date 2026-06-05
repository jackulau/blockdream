"""Fast smoke for the demo trainer (full action-correctness is verified by the
manual full-step run; here we just confirm the pipeline runs + saves a loadable
checkpoint the server can consume)."""

from __future__ import annotations

from pathlib import Path

import torch

from mineworld_wm.train_demo import main
from mineworld_wm.serve import load_demo_session


def test_train_demo_writes_loadable_checkpoint(tmp_path):
    out = tmp_path / "walking.pt"
    rc = main(["--demo", "walking", "--kind", "ar", "--steps", "12", "--tok-steps", "12", "--out", str(out)])
    assert rc in (0, 1)  # 1 only because 12 steps is too few for the >0.6 bar
    assert out.exists()

    ckpt = torch.load(out, map_location="cpu", weights_only=False)
    assert set(["tokenizer", "action", "transition", "demo", "kind"]) <= set(ckpt)

    # the server can load it into a matching demo session
    session = load_demo_session("walking", str(out), kind="ar")
    session.reset()
    res = session.step(torch.tensor([1.0, 0, 0, 0, 0, 0, 0, 0, 0]), torch.zeros(2))
    assert res.frame.shape == (3, 32, 32)
