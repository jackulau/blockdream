"""Minecraft movement types (skills) + a skill-conditioned action encoder.

The world model is conditioned on a movement-type id so one model covers all
locomotion regimes - walking is not enough (elytra glide, boat steering, pig
mount, swimming all have distinct dynamics). Each training pool is tagged with a
type; the tester selects it live.
"""

from __future__ import annotations

import torch
from torch import nn

from .config import ActionConfig
from .actions import ActionEncoder

MOVEMENT_TYPES = [
    "general",   # 0 - mixed gameplay (VPT contractor default)
    "walk",      # 1
    "sprint",    # 2
    "jump",      # 3
    "swim",      # 4
    "boat",      # 5
    "elytra",    # 6
    "pig",       # 7 - riding a saddled pig/horse (mount)
    "minecart",  # 8
]
SKILL_ID = {name: i for i, name in enumerate(MOVEMENT_TYPES)}
N_MOVEMENT = len(MOVEMENT_TYPES)


def skill_id(name: str) -> int:
    return SKILL_ID.get(name, 0)


class SkillRealEncoder(nn.Module):
    """ActionEncoder + a learned per-movement-type bias. forward takes the action
    plus a skill id (per-sample tensor or a single int); falls back to a stored
    `default_skill` so callers that don't pass one (e.g. the server loop) still work."""

    def __init__(self, cfg: ActionConfig, n_skills: int = N_MOVEMENT):
        super().__init__()
        self.base = ActionEncoder(cfg)
        self.skill = nn.Embedding(n_skills, cfg.embed_dim)
        self.n_skills = n_skills
        self.default_skill = 0

    def forward(self, buttons: torch.Tensor, camera: torch.Tensor, skill=None, orientation=None) -> torch.Tensor:
        b = buttons.shape[0]
        if skill is None:
            ids = torch.full((b,), self.default_skill, dtype=torch.long, device=buttons.device)
        elif isinstance(skill, int):
            ids = torch.full((b,), skill, dtype=torch.long, device=buttons.device)
        else:
            ids = skill.to(buttons.device)
        return self.base(buttons, camera, orientation) + self.skill(ids)
