"""commaVQ loader on synthetic commaVQ-shaped data (no 20GB download)."""

from __future__ import annotations

import numpy as np

from blockdream_wm.drive.commavq import load_segment, pseudo_control, TOKENS_PER_FRAME


def test_load_segment_flattens_tokens(tmp_path):
    T = 30
    tok = (np.random.default_rng(0).integers(0, 1024, (T, 8, 16))).astype(np.int16)
    pose = np.random.default_rng(1).standard_normal((T, 4)).astype(np.float32)
    np.save(tmp_path / "token.npy", tok)
    np.save(tmp_path / "pose.npy", pose)
    tokens, p = load_segment(str(tmp_path / "token.npy"), str(tmp_path / "pose.npy"))
    assert tokens.shape == (T, TOKENS_PER_FRAME)
    assert tokens.dtype == np.int64
    assert p.shape == (T, 4)


def test_pseudo_control_shape_and_range():
    pose = np.cumsum(np.random.default_rng(2).standard_normal((40, 4)), axis=0).astype(np.float32)
    ctrl = pseudo_control(pose)
    assert ctrl.shape == (40, 3)
    assert np.abs(ctrl).max() <= 1.0 + 1e-6  # normalized


def test_decoder_default_path_is_absolute_and_cwd_independent(tmp_path, monkeypatch):
    """Regression: the serve path runs from ml/ (serve_demo `cd ml`), so a cwd-relative default
    weights path silently missed the decoder and fell back to the token field. The default must be
    an absolute, cwd-independent location."""
    from blockdream_wm.drive import commavq_decoder as D
    p1 = D.decoder_weights_path()
    monkeypatch.chdir(tmp_path)
    p2 = D.decoder_weights_path()
    assert p1.is_absolute() and p1 == p2
    assert p1.parent.name == "drive" and p1.parent.parent.name == "runs"
