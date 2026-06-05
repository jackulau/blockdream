"""Visual tokenizer: a small conv encoder/decoder with an optional VQ codebook.

- `vq_codebook_size > 0` → VQ-VAE: discrete tokens for the autoregressive path.
- `vq_codebook_size == 0` → continuous latent (plain AE) for the diffusion path.

Kept deliberately tiny; the toy config trains to a clear loss drop on CPU.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn
import torch.nn.functional as F

from .config import TokenizerConfig


class ConvEncoder(nn.Module):
    def __init__(self, cfg: TokenizerConfig):
        super().__init__()
        n_down = int(round(math.log2(cfg.downsample)))
        layers: list[nn.Module] = []
        cin = cfg.in_channels
        cout = cfg.base_channels
        for _ in range(n_down):
            layers += [nn.Conv2d(cin, cout, 4, 2, 1), nn.GroupNorm(1, cout), nn.GELU()]
            cin = cout
            cout = min(cout * 2, cfg.base_channels * 4)
        layers += [nn.Conv2d(cin, cfg.latent_channels, 3, 1, 1)]
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class ConvDecoder(nn.Module):
    def __init__(self, cfg: TokenizerConfig):
        super().__init__()
        n_up = int(round(math.log2(cfg.downsample)))
        layers: list[nn.Module] = [nn.Conv2d(cfg.latent_channels, cfg.base_channels * 2, 3, 1, 1), nn.GELU()]
        cin = cfg.base_channels * 2
        for i in range(n_up):
            cout = cfg.base_channels if i == n_up - 1 else cin
            layers += [nn.ConvTranspose2d(cin, cout, 4, 2, 1), nn.GroupNorm(1, cout), nn.GELU()]
            cin = cout
        layers += [nn.Conv2d(cin, cfg.in_channels, 3, 1, 1)]
        self.net = nn.Sequential(*layers)

    def forward(self, z: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.net(z))


class VectorQuantizer(nn.Module):
    """VQ-VAE codebook with straight-through estimator (van den Oord 2017)."""

    def __init__(self, n_codes: int, dim: int, beta: float = 0.25):
        super().__init__()
        self.n_codes = n_codes
        self.dim = dim
        self.beta = beta
        self.embedding = nn.Embedding(n_codes, dim)
        self.embedding.weight.data.uniform_(-1.0 / n_codes, 1.0 / n_codes)

    def forward(self, z: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        # z: (B, C, h, w)
        b, c, h, w = z.shape
        zp = z.permute(0, 2, 3, 1).contiguous().view(-1, c)  # (B*h*w, C)
        # squared distances to each codebook vector
        d = (
            (zp**2).sum(1, keepdim=True)
            - 2 * zp @ self.embedding.weight.t()
            + (self.embedding.weight**2).sum(1)
        )
        idx = d.argmin(1)
        zq = self.embedding(idx).view(b, h, w, c)
        zp_bhwc = zp.view(b, h, w, c)
        codebook_loss = F.mse_loss(zq, zp_bhwc.detach())
        commit_loss = F.mse_loss(zq.detach(), zp_bhwc)
        loss = codebook_loss + self.beta * commit_loss
        # straight-through: gradients flow to the encoder unchanged
        zq_st = zp_bhwc + (zq - zp_bhwc).detach()
        return zq_st.permute(0, 3, 1, 2).contiguous(), loss, idx.view(b, h, w)


@dataclass
class TokenizerOutput:
    recon: torch.Tensor
    loss: torch.Tensor
    recon_loss: torch.Tensor
    vq_loss: torch.Tensor
    indices: torch.Tensor | None


class Tokenizer(nn.Module):
    def __init__(self, cfg: TokenizerConfig):
        super().__init__()
        self.cfg = cfg
        self.encoder = ConvEncoder(cfg)
        self.decoder = ConvDecoder(cfg)
        self.vq = VectorQuantizer(cfg.vq_codebook_size, cfg.latent_channels, cfg.vq_commit_beta) if cfg.vq_codebook_size > 0 else None

    @property
    def discrete(self) -> bool:
        return self.vq is not None

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return self.encoder(x)

    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return self.decoder(z)

    def tokenize(self, x: torch.Tensor) -> torch.Tensor:
        """Image batch → discrete token grid (B, h, w). Requires a VQ codebook."""
        if self.vq is None:
            raise RuntimeError("tokenize() requires vq_codebook_size > 0")
        _, _, idx = self.vq(self.encode(x))
        return idx

    def forward(self, x: torch.Tensor) -> TokenizerOutput:
        z = self.encode(x)
        vq_loss = torch.zeros((), device=x.device)
        indices: torch.Tensor | None = None
        if self.vq is not None:
            z, vq_loss, indices = self.vq(z)
        recon = self.decode(z)
        recon_loss = F.mse_loss(recon, x)
        return TokenizerOutput(recon, recon_loss + vq_loss, recon_loss, vq_loss, indices)
