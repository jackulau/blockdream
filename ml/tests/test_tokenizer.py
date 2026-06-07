import torch

from blockdream_wm.config import TokenizerConfig
from blockdream_wm.tokenizer import Tokenizer


def toy_cfg(vq: int) -> TokenizerConfig:
    return TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=vq)


def test_latent_shape_and_downsample():
    cfg = toy_cfg(vq=64)
    tok = Tokenizer(cfg)
    x = torch.rand(2, 3, 32, 32)
    z = tok.encode(x)
    assert z.shape == (2, cfg.latent_channels, 8, 8)  # 32 / downsample(4)
    out = tok(x)
    assert out.recon.shape == x.shape


def test_vq_indices_in_range():
    cfg = toy_cfg(vq=64)
    tok = Tokenizer(cfg)
    out = tok(torch.rand(2, 3, 32, 32))
    assert tok.discrete
    assert out.indices is not None
    assert int(out.indices.min()) >= 0
    assert int(out.indices.max()) < cfg.vq_codebook_size


def test_continuous_mode_has_no_indices():
    cfg = toy_cfg(vq=0)
    tok = Tokenizer(cfg)
    out = tok(torch.rand(2, 3, 32, 32))
    assert not tok.discrete
    assert out.indices is None


def _overfit(vq: int) -> tuple[float, float]:
    torch.manual_seed(0)
    cfg = toy_cfg(vq=vq)
    tok = Tokenizer(cfg)
    opt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    # one fixed toy batch with structure (a couple of solid-color tiles)
    x = torch.zeros(4, 3, 32, 32)
    x[:, 0, :16, :] = 0.9
    x[:, 1, 16:, :] = 0.8
    x[:, 2, :, :16] = 0.5
    first = None
    last = 0.0
    for step in range(250):
        out = tok(x)
        opt.zero_grad()
        out.loss.backward()
        opt.step()
        if first is None:
            first = out.recon_loss.item()
        last = out.recon_loss.item()
    assert first is not None
    return first, last


def test_vqvae_overfits_toy_batch():
    first, last = _overfit(vq=64)
    assert last < first * 0.5, f"recon loss did not halve: {first:.4f} -> {last:.4f}"


def test_continuous_ae_overfits_toy_batch():
    first, last = _overfit(vq=0)
    assert last < first * 0.5, f"recon loss did not halve: {first:.4f} -> {last:.4f}"
