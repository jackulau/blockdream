"""Synthetic action-labeled rollouts + an Inverse Dynamics Model (IDM) stub.

The `MovingDotEnv` is a tiny, fully-deterministic, action-conditioned world: a
bright dot moves under button/camera actions. It stands in for real
action-labeled Minecraft data (VPT/MineRL) so the tokenizer, IDM, and transition
models have genuine `S_t + A_t → S_{t+1}` dynamics to fit on CPU.

The real pipeline swaps this for VPT contractor data + the IDM that labels
unlabeled YouTube — same tensor contract (frames, buttons, camera).
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn

from .config import ActionConfig


@dataclass
class Rollout:
    frames: torch.Tensor   # (T, 3, H, W) in [0, 1]
    buttons: torch.Tensor  # (T, n_buttons) in {0, 1}
    camera: torch.Tensor   # (T, 2) in [-1, 1]


class MovingDotEnv:
    """Deterministic moving-dot world. button[0..3] = up/down/left/right nudges;
    camera (dx, dy) adds continuous motion. Frame = a 3×3 bright patch at the dot."""

    def __init__(self, size: int = 32, n_buttons: int = 9, step: float = 3.0):
        self.size = size
        self.n_buttons = n_buttons
        self.step = step

    def _render(self, x: float, y: float) -> torch.Tensor:
        img = torch.zeros(3, self.size, self.size)
        cx = int(round(x))
        cy = int(round(y))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                px = min(max(cx + dx, 0), self.size - 1)
                py = min(max(cy + dy, 0), self.size - 1)
                img[:, py, px] = 1.0
        return img

    def rollout(self, seq_len: int, generator: torch.Generator) -> Rollout:
        s = self.size
        x = float(torch.randint(4, s - 4, (1,), generator=generator).item())
        y = float(torch.randint(4, s - 4, (1,), generator=generator).item())
        frames, buttons, camera = [], [], []
        for _ in range(seq_len):
            frames.append(self._render(x, y))
            btn = torch.zeros(self.n_buttons)
            # pick at most one directional button
            choice = int(torch.randint(0, 5, (1,), generator=generator).item())  # 0=none,1..4 dirs
            if choice >= 1:
                btn[choice - 1] = 1.0
            cam = (torch.rand(2, generator=generator) * 2 - 1) * 0.5
            buttons.append(btn)
            camera.append(cam)
            # apply dynamics for the NEXT frame
            if btn[0] > 0:
                y -= self.step
            if btn[1] > 0:
                y += self.step
            if btn[2] > 0:
                x -= self.step
            if btn[3] > 0:
                x += self.step
            x += float(cam[0]) * self.step
            y += float(cam[1]) * self.step
            x = min(max(x, 0.0), s - 1.0)
            y = min(max(y, 0.0), s - 1.0)
        return Rollout(torch.stack(frames), torch.stack(buttons), torch.stack(camera))


def make_rollouts(n: int, seq_len: int, size: int = 32, n_buttons: int = 9, seed: int = 0) -> list[Rollout]:
    env = MovingDotEnv(size=size, n_buttons=n_buttons)
    g = torch.Generator().manual_seed(seed)
    return [env.rollout(seq_len, g) for _ in range(n)]


class InverseDynamicsModel(nn.Module):
    """IDM stub: predict the action that took frame_t → frame_{t+1}.

    Mirrors VPT's IDM (which labels unlabeled video). Here a small CNN over the
    concatenated frame pair predicts button logits + continuous camera.
    """

    def __init__(self, cfg: ActionConfig, size: int = 32):
        super().__init__()
        self.cfg = cfg
        self.net = nn.Sequential(
            nn.Conv2d(6, 16, 4, 2, 1), nn.GELU(),       # 32 -> 16
            nn.Conv2d(16, 32, 4, 2, 1), nn.GELU(),      # 16 -> 8
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
        )
        self.button_head = nn.Linear(32, cfg.n_buttons)
        self.camera_head = nn.Linear(32, 2)

    def forward(self, frame_t: torch.Tensor, frame_t1: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.net(torch.cat([frame_t, frame_t1], dim=1))
        return self.button_head(h), torch.tanh(self.camera_head(h))


def label_rollout(idm: InverseDynamicsModel, frames: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Run the IDM over a frame sequence to produce pseudo-action labels."""
    btn_logits, cam = idm(frames[:-1], frames[1:])
    return btn_logits, cam
