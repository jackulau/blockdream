"""Recursive multimodal transition: S_t + control_t → S_{t+1}, where S = (RGB
tokens, LiDAR, telemetry). The control + prev LiDAR + prev telemetry fuse into a
conditioning vector that (a) drives an autoregressive transformer over the next
RGB tokens and (b) feeds per-modality heads predicting next LiDAR + next telemetry.
This is the drift-sim recipe (fused transition + per-modality decoder heads).
"""

from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F

from ..config import DynamicsConfig
from ..transition_ar import ARTransition


class DriveTransition(nn.Module):
    def __init__(self, cfg: DynamicsConfig, n_tokens: int, codebook_size: int,
                 n_lidar: int, n_telemetry: int, n_control: int = 3, cond_dim: int = 96):
        super().__init__()
        self.n_lidar = n_lidar
        self.n_telemetry = n_telemetry
        # fuse control + prev LiDAR + prev telemetry → conditioning
        self.cond = nn.Sequential(
            nn.Linear(n_control + n_lidar + n_telemetry, cond_dim), nn.GELU(),
            nn.Linear(cond_dim, cond_dim),
        )
        self.ar = ARTransition(cfg, n_tokens=n_tokens, codebook_size=codebook_size, action_dim=cond_dim)
        self.lidar_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_lidar))
        self.telemetry_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_telemetry))

    def _fuse(self, control: torch.Tensor, lidar: torch.Tensor, telemetry: torch.Tensor) -> torch.Tensor:
        return self.cond(torch.cat([control, lidar, telemetry], dim=-1))

    def loss(self, prev_tokens, next_tokens, prev_lidar, prev_tel, control, next_lidar, next_tel):
        c = self._fuse(control, prev_lidar, prev_tel)
        rgb_loss = self.ar.loss(prev_tokens, next_tokens, c)
        lidar_loss = F.mse_loss(torch.sigmoid(self.lidar_head(c)), next_lidar)
        tel_loss = F.mse_loss(self.telemetry_head(c), next_tel)
        return rgb_loss + lidar_loss + tel_loss, {"rgb": rgb_loss.item(), "lidar": lidar_loss.item(), "tel": tel_loss.item()}

    @torch.no_grad()
    def step(self, prev_tokens, prev_lidar, prev_tel, control):
        """One recursive world-model step → (next_tokens, next_lidar, next_telemetry)."""
        c = self._fuse(control, prev_lidar, prev_tel)
        next_tokens = self.ar.generate(prev_tokens, c)
        next_lidar = torch.sigmoid(self.lidar_head(c))
        next_tel = self.telemetry_head(c)
        return next_tokens, next_lidar, next_tel
