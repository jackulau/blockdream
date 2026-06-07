"""Few-step latent-diffusion transition net (browser lineage).

Rectified flow over CONTINUOUS VAE latents: predict the next-frame latent from
the previous latent + action, generatively (so Minecraft stochasticity is
modeled, unlike a deterministic regressor). Few Euler steps → browser-friendly
latency. This is the in-browser counterpart to the server AR path; ONNX export
of this net + the VAE decoder is D8.
"""

from __future__ import annotations

import math

import torch
from torch import nn
import torch.nn.functional as F

from .config import DynamicsConfig


def timestep_embedding(t: torch.Tensor, dim: int) -> torch.Tensor:
    """Sinusoidal embedding of t∈[0,1] → (B, dim)."""
    half = dim // 2
    freqs = torch.exp(-math.log(10000) * torch.arange(half, device=t.device) / max(half - 1, 1))
    args = t[:, None] * freqs[None] * 1000.0
    emb = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
    if dim % 2:
        emb = F.pad(emb, (0, 1))
    return emb


class FiLMResBlock(nn.Module):
    def __init__(self, dim: int, cond_dim: int):
        super().__init__()
        self.norm1 = nn.GroupNorm(8 if dim % 8 == 0 else 1, dim)
        self.conv1 = nn.Conv2d(dim, dim, 3, 1, 1)
        self.norm2 = nn.GroupNorm(8 if dim % 8 == 0 else 1, dim)
        self.conv2 = nn.Conv2d(dim, dim, 3, 1, 1)
        self.film = nn.Linear(cond_dim, dim * 2)

    def forward(self, x: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        h = self.conv1(F.gelu(self.norm1(x)))
        scale, shift = self.film(cond)[:, :, None, None].chunk(2, dim=1)
        h = h * (1 + scale) + shift
        h = self.conv2(F.gelu(self.norm2(h)))
        return x + h


class LatentDiffusionTransition(nn.Module):
    def __init__(self, cfg: DynamicsConfig, latent_channels: int, action_dim: int):
        super().__init__()
        self.cfg = cfg
        self.latent_channels = latent_channels
        dim = cfg.dim
        self.cond_dim = dim
        self.time_mlp = nn.Sequential(nn.Linear(dim, dim), nn.GELU(), nn.Linear(dim, dim))
        self.action_proj = nn.Linear(action_dim, dim)
        # input = noised next latent (C) concat prev latent (C) → 2C
        self.in_proj = nn.Conv2d(latent_channels * 2, dim, 3, 1, 1)
        self.blocks = nn.ModuleList([FiLMResBlock(dim, dim) for _ in range(max(2, cfg.depth // 2))])
        self.out_proj = nn.Conv2d(dim, latent_channels, 3, 1, 1)

    def _cond(self, t: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        return self.time_mlp(timestep_embedding(t, self.cfg.dim)) + self.action_proj(action_emb)

    def forward(self, z_t: torch.Tensor, t: torch.Tensor, prev: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        """Predict the rectified-flow velocity (z1 - z0) at (z_t, t)."""
        cond = self._cond(t, action_emb)
        h = self.in_proj(torch.cat([z_t, prev], dim=1))
        for blk in self.blocks:
            h = blk(h, cond)
        return self.out_proj(h)

    def loss(self, z_next: torch.Tensor, prev: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        b = z_next.shape[0]
        z0 = torch.randn_like(z_next)
        t = torch.rand(b, device=z_next.device)
        z_t = (1 - t)[:, None, None, None] * z0 + t[:, None, None, None] * z_next
        target = z_next - z0  # constant rectified-flow velocity
        pred = self.forward(z_t, t, prev, action_emb)
        return F.mse_loss(pred, target)

    @torch.no_grad()
    def sample(self, prev: torch.Tensor, action_emb: torch.Tensor, steps: int | None = None) -> torch.Tensor:
        """Few-step Euler integration from noise → next latent."""
        k = steps or self.cfg.diffusion_steps
        b, c, h, w = prev.shape
        z = torch.randn(b, c, h, w, device=prev.device)
        dt = 1.0 / k
        for i in range(k):
            t = torch.full((b,), i * dt, device=prev.device)
            v = self.forward(z, t, prev, action_emb)
            z = z + v * dt
        return z
