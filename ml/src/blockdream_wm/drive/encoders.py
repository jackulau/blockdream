"""Multimodal encoders for the driving world model.

State modalities: RGB (VQ tokens, reuse the image Tokenizer), LiDAR (range vector
→ MLP latent), telemetry (small vector, predicted by a head). Action = control
(steer/throttle/brake) → conditioning embedding. The transition (D3) predicts the
next RGB tokens + next LiDAR + next telemetry from (prev state, control).
"""

from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F


class LidarCodec(nn.Module):
    """Encode/decode a normalized LiDAR range vector (B, n_rays) ↔ latent (B, dim)."""

    def __init__(self, n_rays: int, dim: int = 32):
        super().__init__()
        self.enc = nn.Sequential(nn.Linear(n_rays, 64), nn.GELU(), nn.Linear(64, dim))
        self.dec = nn.Sequential(nn.Linear(dim, 64), nn.GELU(), nn.Linear(64, n_rays))

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return self.enc(x)

    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.dec(z))  # ranges are normalized [0,1]

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        z = self.encode(x)
        return self.decode(z), z

    def loss(self, x: torch.Tensor) -> torch.Tensor:
        recon, _ = self(x)
        return F.mse_loss(recon, x)


class ControlEncoder(nn.Module):
    """Driving control (steer, throttle, brake) → conditioning embedding."""

    def __init__(self, embed_dim: int = 64, n_control: int = 3):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(n_control, embed_dim), nn.GELU(), nn.Linear(embed_dim, embed_dim))

    def forward(self, control: torch.Tensor) -> torch.Tensor:
        return self.net(control)
