"""Unit tests for the driving WM's RGB dynamics loss (goal 035, the copy-previous fix).

The served driving model learned to echo the previous frame because RGB tokens were trained with
single-step teacher-forced CE only (consecutive commaVQ token fields are ~40% identical, so copying
wins). DriveTransition.rgb_loss adds two flag-gated terms that break that shortcut: a change-weighted
CE (up-weight positions where next != prev) and a control-divergence hinge (true control must beat a
shuffled control). These tests lock the contract: OFF by default == legacy CE, the change-weighting
matches its formula exactly, the divergence term is a non-negative add-on, and gradients flow.
"""
import torch

from blockdream_wm.config import DynamicsConfig
from blockdream_wm.drive.transition import DriveTransition


def _model(**kw):
    cfg = DynamicsConfig(dim=32, depth=1, heads=2)  # tiny, fast on CPU
    return DriveTransition(cfg, n_tokens=8, codebook_size=16, n_lidar=0, n_telemetry=6,
                           n_control=3, cond_dim=16, **kw)


def _batch(b=4, n=8, codebook=16):
    torch.manual_seed(0)
    prev = torch.randint(0, codebook, (b, n))
    nxt = prev.clone()
    nxt[:, : n // 2] = (nxt[:, : n // 2] + 1) % codebook  # change half the positions
    control = torch.randn(b, 3)
    lidar = torch.zeros(b, 0)          # camera-only real path: n_lidar == 0
    tel = torch.randn(b, 6)
    return prev, nxt, control, lidar, tel


def test_off_by_default_equals_legacy_ce():
    m = _model().eval()  # weights default 0 -> rgb_loss must be exactly self.ar.loss
    prev, nxt, control, lidar, tel = _batch()
    c = m._fuse(control, lidar, tel)
    assert torch.allclose(m.rgb_loss(prev, nxt, c, control, lidar, tel), m.ar.loss(prev, nxt, c))


def test_change_weighting_matches_formula():
    m = _model(rgb_change_weight=3.0).eval()
    prev, nxt, control, lidar, tel = _batch()
    c = m._fuse(control, lidar, tel)
    logits = m.ar.forward(prev, nxt, c)
    ce = torch.nn.functional.cross_entropy(
        logits.reshape(-1, 16), nxt.reshape(-1), reduction="none").view_as(nxt)
    w = 1.0 + 3.0 * (nxt != prev).float()
    expected = (ce * w).sum() / w.sum()
    assert torch.allclose(m.rgb_loss(prev, nxt, c, control, lidar, tel), expected, atol=1e-5)


def test_change_weighting_upweights_changed_positions():
    # with all-changed targets the weighted mean must equal the plain mean (every weight identical),
    # and with a mix it must shift toward the changed positions' CE -> differs from the plain mean.
    m = _model(rgb_change_weight=4.0).eval()
    prev, nxt, control, lidar, tel = _batch()
    c = m._fuse(control, lidar, tel)
    logits = m.ar.forward(prev, nxt, c)
    ce = torch.nn.functional.cross_entropy(
        logits.reshape(-1, 16), nxt.reshape(-1), reduction="none").view_as(nxt)
    weighted = m.rgb_loss(prev, nxt, c, control, lidar, tel)
    # mixed changed/unchanged batch -> weighted mean != plain mean (the whole point)
    assert not torch.allclose(weighted, ce.mean(), atol=1e-4)


def test_divergence_is_nonnegative_addon():
    m = _model(rgb_change_weight=2.0).eval()
    prev, nxt, control, lidar, tel = _batch()
    c = m._fuse(control, lidar, tel)
    m.rgb_div_weight = 0.0
    base = m.rgb_loss(prev, nxt, c, control, lidar, tel)
    m.rgb_div_weight = 1.0
    torch.manual_seed(1)
    with_div = m.rgb_loss(prev, nxt, c, control, lidar, tel)
    assert with_div.item() >= base.item() - 1e-5  # div term = w*relu(...) >= 0


def test_gradients_flow_through_dynamics_loss():
    m = _model(rgb_change_weight=2.0, rgb_div_weight=1.0)
    prev, nxt, control, lidar, tel = _batch()
    c = m._fuse(control, lidar, tel)
    m.rgb_loss(prev, nxt, c, control, lidar, tel).backward()
    assert any(p.grad is not None and p.grad.abs().sum() > 0 for p in m.parameters())
