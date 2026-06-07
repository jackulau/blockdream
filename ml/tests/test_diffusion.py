import torch

from blockdream_wm.config import TokenizerConfig, ActionConfig, DynamicsConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.actions import ActionEncoder
from blockdream_wm.data import make_rollouts
from blockdream_wm.transition_diffusion import LatentDiffusionTransition, timestep_embedding


def _setup():
    torch.manual_seed(0)
    tcfg = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=0)
    acfg = ActionConfig(embed_dim=32)
    dcfg = DynamicsConfig(kind="diffusion", dim=32, depth=4, diffusion_steps=8)
    tok = Tokenizer(tcfg)  # continuous AE (vq=0)
    enc = ActionEncoder(acfg)
    net = LatentDiffusionTransition(dcfg, latent_channels=tcfg.latent_channels, action_dim=acfg.embed_dim)
    return tok, enc, net


def _latents(tok, enc):
    roll = make_rollouts(n=1, seq_len=6, size=32, seed=4)[0]
    with torch.no_grad():
        z = tok.encode(roll.frames)  # (6, C, 8, 8)
    action = enc(roll.buttons[:-1], roll.camera[:-1]).detach()
    return z[:-1].detach(), z[1:].detach(), action


def test_timestep_embedding_shape():
    emb = timestep_embedding(torch.rand(5), 32)
    assert emb.shape == (5, 32)


def test_forward_and_sample_shapes():
    tok, enc, net = _setup()
    prev, nxt, act = _latents(tok, enc)
    t = torch.rand(prev.shape[0])
    v = net(nxt, t, prev, act)
    assert v.shape == nxt.shape
    s = net.sample(prev, act, steps=8)
    assert s.shape == prev.shape


def test_loss_step_backward():
    tok, enc, net = _setup()
    prev, nxt, act = _latents(tok, enc)
    loss = net.loss(nxt, prev, act)
    loss.backward()
    assert all(p.grad is not None for p in net.parameters() if p.requires_grad)


def test_overfits_latent_transition():
    tok, enc, net = _setup()
    prev, nxt, act = _latents(tok, enc)
    opt = torch.optim.Adam(net.parameters(), lr=3e-3)

    def sample_mse() -> float:
        s = net.sample(prev, act, steps=8)
        return torch.nn.functional.mse_loss(s, nxt).item()

    before = sample_mse()
    for _ in range(400):
        loss = net.loss(nxt, prev, act)
        opt.zero_grad()
        loss.backward()
        opt.step()
    after = sample_mse()
    assert after < before * 0.5, f"sampling did not converge to next latent: {before:.3f} -> {after:.3f}"
