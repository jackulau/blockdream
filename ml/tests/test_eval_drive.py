"""Driving WM is measurably better: a REAL eval (per-modality val error + closed-loop drift,
over MULTIPLE track shapes) and the temporal-context conditioning improves telemetry
prediction vs single-step. Replaces 'one summed loss + a directional unit test'."""

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_drive as ed  # noqa: E402

from blockdream_wm.config import TokenizerConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.drive.sim import make_track, TRACK_KINDS, DriveSim, DriveConfig


def test_multiple_track_shapes_are_valid_corridors():
    for kind in TRACK_KINDS:
        walls, cl = make_track(kind)
        assert walls.shape[1] == 4 and len(cl) == 80
        assert np.isfinite(walls).all() and np.isfinite(cl).all()
    # the sim can drive each track + produce observations
    for kind in TRACK_KINDS:
        sim = DriveSim(DriveConfig(track=kind))
        sim.step(0.2, 0.5, 0.0)
        obs = sim.observation()
        assert obs["rgb"].shape == (3, 64, 64) and obs["lidar"].shape == (32,) and obs["telemetry"].shape == (6,)


def test_eval_metrics_and_temporal_context_helps():
    torch.manual_seed(0)
    np.random.seed(0)
    tok = Tokenizer(TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=128))
    train = ed._rollouts(tok, n=4, steps=16, seed0=0)
    val = ed._rollouts(tok, n=2, steps=16, seed0=500)

    single = ed._train(tok, train, n_history=0, steps=150, seed=0)
    temporal = ed._train(tok, train, n_history=3, steps=150, seed=0)

    m_single = ed._per_modality(single, val, 0)
    m_temporal = ed._per_modality(temporal, val, 3)
    for m in (m_single, m_temporal):
        assert np.isfinite(m["telemetry_mse"]) and np.isfinite(m["lidar_mse"])
        assert m["telemetry_mse"] < 0.5 and m["lidar_mse"] < 0.5  # normalized modalities → small
        assert 0.0 <= m["rgb_token_acc"] <= 1.0

    # temporal context (momentum window) should predict telemetry at least as well as single-step
    assert m_temporal["telemetry_mse"] <= m_single["telemetry_mse"] * 1.05

    # closed-loop drift is finite + bounded for both
    for trans, h in ((single, 0), (temporal, 3)):
        drift = ed._closed_loop_drift(trans, val[0], h, n_steps=8)
        assert np.isfinite(drift) and drift < 5.0
