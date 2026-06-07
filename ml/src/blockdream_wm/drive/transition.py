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
                 n_lidar: int, n_telemetry: int, n_control: int = 3, cond_dim: int = 96,
                 n_history: int = 0):
        super().__init__()
        self.n_lidar = n_lidar
        self.n_telemetry = n_telemetry
        self.n_control = n_control
        # TEMPORAL CONTEXT: optionally condition on a window of the last n_history
        # (control, telemetry) frames so the dynamics see momentum/lag, not just the current
        # step (single-step telemetry prediction drifts over long rollouts). n_history=0 → the
        # original single-step behaviour (backward compatible; no extra params).
        self.n_history = n_history
        # fuse control + prev LiDAR + prev telemetry → conditioning
        self.cond = nn.Sequential(
            nn.Linear(n_control + n_lidar + n_telemetry, cond_dim), nn.GELU(),
            nn.Linear(cond_dim, cond_dim),
        )
        if n_history > 0:
            self.hist_proj: nn.Module = nn.Linear(n_history * (n_control + n_telemetry), cond_dim)
        self.ar = ARTransition(cfg, n_tokens=n_tokens, codebook_size=codebook_size, action_dim=cond_dim)
        self.lidar_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_lidar))
        self.telemetry_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_telemetry))

    def _fuse(self, control: torch.Tensor, lidar: torch.Tensor, telemetry: torch.Tensor,
              history: torch.Tensor | None = None) -> torch.Tensor:
        c = self.cond(torch.cat([control, lidar, telemetry], dim=-1))
        if self.n_history > 0:
            if history is None:
                history = control.new_zeros((control.shape[0], self.n_history * (self.n_control + self.n_telemetry)))
            c = c + self.hist_proj(history)
        return c

    def loss(self, prev_tokens, next_tokens, prev_lidar, prev_tel, control, next_lidar, next_tel, history=None):
        c = self._fuse(control, prev_lidar, prev_tel, history)
        rgb_loss = self.ar.loss(prev_tokens, next_tokens, c)
        lidar_loss = F.mse_loss(torch.sigmoid(self.lidar_head(c)), next_lidar)
        tel_loss = F.mse_loss(self.telemetry_head(c), next_tel)
        return rgb_loss + lidar_loss + tel_loss, {"rgb": rgb_loss.item(), "lidar": lidar_loss.item(), "tel": tel_loss.item()}

    @torch.no_grad()
    def step(self, prev_tokens, prev_lidar, prev_tel, control, history=None):
        """One recursive world-model step → (next_tokens, next_lidar, next_telemetry)."""
        c = self._fuse(control, prev_lidar, prev_tel, history)
        next_tokens = self.ar.generate(prev_tokens, c)
        next_lidar = torch.sigmoid(self.lidar_head(c))
        next_tel = self.telemetry_head(c)
        return next_tokens, next_lidar, next_tel
