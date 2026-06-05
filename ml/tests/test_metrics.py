import torch

from mineworld_wm.config import TokenizerConfig, ActionConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.actions import ActionEncoder
from mineworld_wm.data import make_rollouts
from mineworld_wm.transition_diffusion import LatentDiffusionTransition
from mineworld_wm.metrics import reconstruction_mse, fvd_stub, action_conditioning_score


def test_reconstruction_mse_is_a_float():
    tok = Tokenizer(TokenizerConfig(image_size=32, base_channels=16, downsample=4, vq_codebook_size=64))
    m = reconstruction_mse(tok, torch.rand(3, 3, 32, 32))
    assert isinstance(m, float) and m >= 0


def test_fvd_stub_zero_for_identical_positive_for_different():
    a = torch.rand(8, 3, 16, 16)
    assert fvd_stub(a, a) < 1e-5
    assert fvd_stub(a, torch.rand(8, 3, 16, 16) + 2.0) > 0


def test_action_conditioning_score_runs():
    torch.manual_seed(0)
    tcfg = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=0)
    acfg = ActionConfig(embed_dim=32)
    dcfg = DynamicsConfig(kind="diffusion", dim=32, depth=4, diffusion_steps=6)
    tok = Tokenizer(tcfg)
    enc = ActionEncoder(acfg)
    net = LatentDiffusionTransition(dcfg, latent_channels=4, action_dim=32)
    roll = make_rollouts(n=1, seq_len=5, size=32, seed=1)[0]
    with torch.no_grad():
        z = tok.encode(roll.frames)
    action = enc(roll.buttons[:-1], roll.camera[:-1])
    score = action_conditioning_score(net, z[:-1], z[1:], action, steps=6)
    assert isinstance(score, float) and score > 0
