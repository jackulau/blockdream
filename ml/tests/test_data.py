import torch

from mineworld_wm.config import ActionConfig
from mineworld_wm.actions import ActionEncoder, bin_camera, unbin_camera, mask_inactive_buttons
from mineworld_wm.data import MovingDotEnv, make_rollouts, InverseDynamicsModel


def test_action_encoder_shapes_both_modes():
    for cont in (True, False):
        cfg = ActionConfig(camera_continuous=cont, embed_dim=32)
        enc = ActionEncoder(cfg)
        b = (torch.rand(5, cfg.n_buttons) > 0.5).float()
        cam = torch.rand(5, 2) * 2 - 1
        out = enc(b, cam)
        assert out.shape == (5, 32)


def test_camera_bin_roundtrip_within_bin_width():
    bins = 11
    cam = torch.linspace(-1, 1, 21).unsqueeze(1)  # (21, 1)
    idx = bin_camera(cam, bins)
    assert int(idx.min()) >= 0 and int(idx.max()) < bins
    back = unbin_camera(idx, bins)  # (21, 1) — same shape, no broadcast
    half_bin = 1.0 / (bins - 1)
    assert torch.all((back - cam).abs() <= half_bin + 1e-6)


def test_mask_inactive_buttons():
    b = torch.ones(3, 9)
    masked = mask_inactive_buttons(b, active=[0, 3, 8])
    assert masked[:, 0].sum() == 3 and masked[:, 1].sum() == 0 and masked[:, 8].sum() == 3


def test_rollout_shapes_and_dynamics():
    rs = make_rollouts(n=2, seq_len=6, size=32, n_buttons=9, seed=1)
    r = rs[0]
    assert r.frames.shape == (6, 3, 32, 32)
    assert r.buttons.shape == (6, 9)
    assert r.camera.shape == (6, 2)
    # frames should change over time (the dot moves)
    assert not torch.allclose(r.frames[0], r.frames[-1])


def test_idm_overfits_button_direction():
    # IDM should learn to recover the action from a frame pair on synthetic data
    torch.manual_seed(0)
    cfg = ActionConfig()
    idm = InverseDynamicsModel(cfg, size=32)
    rolls = make_rollouts(n=24, seq_len=8, seed=2)
    ft = torch.cat([r.frames[:-1] for r in rolls])
    ft1 = torch.cat([r.frames[1:] for r in rolls])
    btn = torch.cat([r.buttons[:-1] for r in rolls])
    opt = torch.optim.Adam(idm.parameters(), lr=2e-3)
    first = last = None
    for _ in range(120):
        logits, _ = idm(ft, ft1)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, btn)
        opt.zero_grad()
        loss.backward()
        opt.step()
        if first is None:
            first = loss.item()
        last = loss.item()
    assert last < first * 0.6, f"IDM did not learn: {first:.3f} -> {last:.3f}"
