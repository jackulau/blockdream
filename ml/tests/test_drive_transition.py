import torch

from blockdream_wm.config import TokenizerConfig, DynamicsConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.drive.transition import DriveTransition
from blockdream_wm.drive.collect import collect_rollout


def _setup():
    torch.manual_seed(0)
    tok = Tokenizer(TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=128))
    dcfg = DynamicsConfig(kind="ar", dim=64, depth=2, heads=4)
    n_tokens = 8 * 8
    trans = DriveTransition(dcfg, n_tokens=n_tokens, codebook_size=128, n_lidar=32, n_telemetry=6)
    return tok, trans


def _rollout_tensors(tok):
    r = collect_rollout(steps=24, seed=2)
    rgb = torch.from_numpy(r["rgb"]).float() / 255.0
    with torch.no_grad():
        tokens = tok.tokenize(rgb).flatten(1)  # (T, 64)
    lidar = torch.from_numpy(r["lidar"]).float()
    tel = torch.from_numpy(r["telemetry"]).float()
    ctl = torch.from_numpy(r["control"]).float()
    return tokens, lidar, tel, ctl


def test_drive_transition_overfits_a_rollout():
    tok, trans = _setup()
    tokens, lidar, tel, ctl = _rollout_tensors(tok)
    opt = torch.optim.Adam(trans.parameters(), lr=2e-3)
    first = None
    for _ in range(250):
        loss, parts = trans.loss(tokens[:-1], tokens[1:], lidar[:-1], tel[:-1], ctl[:-1], lidar[1:], tel[1:])
        opt.zero_grad(); loss.backward(); opt.step()
        if first is None:
            first = loss.item()
    assert loss.item() < first * 0.5
    assert parts["lidar"] < 0.02 and parts["tel"] < 0.05  # modalities predicted well


def test_step_predicts_all_modalities():
    tok, trans = _setup()
    tokens, lidar, tel, ctl = _rollout_tensors(tok)
    nt, nl, ntel = trans.step(tokens[:1], lidar[:1], tel[:1], ctl[:1])
    assert nt.shape == (1, 64)
    assert nl.shape == (1, 32) and (nl >= 0).all() and (nl <= 1).all()
    assert ntel.shape == (1, 6)


def test_control_changes_the_prediction():
    tok, trans = _setup()
    tokens, lidar, tel, ctl = _rollout_tensors(tok)
    left = torch.tensor([[-1.0, 0.6, 0.0]])
    right = torch.tensor([[1.0, 0.6, 0.0]])
    _, nl_left, ntel_left = trans.step(tokens[:1], lidar[:1], tel[:1], left)
    _, nl_right, ntel_right = trans.step(tokens[:1], lidar[:1], tel[:1], right)
    # different control → different predicted next LiDAR + telemetry
    assert not torch.allclose(nl_left, nl_right)
    assert not torch.allclose(ntel_left, ntel_right)
