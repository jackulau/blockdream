"""VPT-style action space: discrete buttons + camera (continuous or binned).

The same logical action feeds both backbones:
  * AR path  → camera binned to `camera_bins`, buttons multi-hot → token/embedding
  * diffusion path → continuous camera, buttons multi-hot → embedding
"""

from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F

from .config import ActionConfig


def bin_camera(camera: torch.Tensor, bins: int) -> torch.Tensor:
    """Map continuous camera in [-1, 1] → integer bin in [0, bins)."""
    c = camera.clamp(-1.0, 1.0)
    idx = ((c + 1.0) / 2.0 * (bins - 1)).round().long()
    return idx.clamp(0, bins - 1)


def unbin_camera(idx: torch.Tensor, bins: int) -> torch.Tensor:
    """Map bin index → the continuous bin center in [-1, 1]."""
    return idx.float() / (bins - 1) * 2.0 - 1.0


class ActionEncoder(nn.Module):
    """Encode (buttons, camera) → a fixed-width action embedding."""

    def __init__(self, cfg: ActionConfig):
        super().__init__()
        self.cfg = cfg
        self.button_proj = nn.Linear(cfg.n_buttons, cfg.embed_dim)
        if cfg.camera_continuous:
            self.camera_proj: nn.Module = nn.Linear(2, cfg.embed_dim)
        else:
            # two axes, each embedded then summed
            self.camera_emb = nn.Embedding(cfg.camera_bins, cfg.embed_dim)
            self.camera_proj = nn.Identity()
        self.out = nn.Linear(cfg.embed_dim, cfg.embed_dim)

    def forward(self, buttons: torch.Tensor, camera: torch.Tensor) -> torch.Tensor:
        # buttons: (B, n_buttons) float multi-hot; camera: (B, 2) continuous
        b = self.button_proj(buttons)
        if self.cfg.camera_continuous:
            c = self.camera_proj(camera)
        else:
            idx = bin_camera(camera, self.cfg.camera_bins)  # (B, 2)
            c = self.camera_emb(idx).sum(dim=1)
        return self.out(F.gelu(b + c))


def mask_inactive_buttons(buttons: torch.Tensor, active: list[int]) -> torch.Tensor:
    """Zero out buttons not in a demo's active set (per-demo conditioning)."""
    mask = torch.zeros(buttons.shape[-1], dtype=buttons.dtype, device=buttons.device)
    for i in active:
        if 0 <= i < buttons.shape[-1]:
            mask[i] = 1.0
    return buttons * mask
