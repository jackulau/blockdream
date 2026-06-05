"""The five mineworld demos.

Each demo conditions the world model two ways:
  1. an ACTION SUBSET — only the buttons that skill uses are exposed
     (boat = steering only; elytra = jump + look; world/gameplay = everything)
  2. a learned SKILL embedding added to every action (a per-skill bias token)

Backbone per PLAN: walking/boat/elytra → browser diffusion (smooth continuous
camera, few-step latency); world/gameplay → server AR (full action space).
Walking ships first (simplest dynamics).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import torch
from torch import nn

from .config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from .tokenizer import Tokenizer
from .actions import ActionEncoder
from .transition_ar import ARTransition
from .transition_diffusion import LatentDiffusionTransition
from .serve import WorldModelSession

# button indices: 0 fwd 1 back 2 left 3 right 4 jump 5 sneak 6 sprint 7 attack 8 use


@dataclass
class DemoSpec:
    name: str
    skill_id: int
    active_buttons: list[int]
    kind: str  # "diffusion" (browser) | "ar" (server)
    description: str = ""


DEMOS: dict[str, DemoSpec] = {
    "walking": DemoSpec("walking", 0, [0, 1, 2, 3, 4, 5, 6], "diffusion", "ground locomotion; simplest dynamics — ships first"),
    "boat": DemoSpec("boat", 1, [0, 1, 2, 3], "diffusion", "boat steering on water"),
    "elytra": DemoSpec("elytra", 2, [0, 4], "diffusion", "elytra glide; camera-dominant, high speed"),
    "world": DemoSpec("world", 3, list(range(9)), "ar", "general open-world model, full action space"),
    "gameplay": DemoSpec("gameplay", 4, list(range(9)), "ar", "general gameplay incl. attack/use"),
}

N_SKILLS = len(DEMOS)


class DemoEncoder(nn.Module):
    """Action encoder bound to one demo: masks inactive buttons + adds a skill bias."""

    def __init__(self, base: ActionEncoder, embed_dim: int, spec: DemoSpec):
        super().__init__()
        self.base = base
        self.skill = nn.Embedding(N_SKILLS, embed_dim)
        self.skill_id = spec.skill_id
        mask = torch.zeros(base.cfg.n_buttons)
        for i in spec.active_buttons:
            mask[i] = 1.0
        self.register_buffer("button_mask", mask)

    def forward(self, buttons: torch.Tensor, camera: torch.Tensor) -> torch.Tensor:
        b = buttons * self.button_mask
        skill = self.skill(torch.full((buttons.shape[0],), self.skill_id, dtype=torch.long, device=buttons.device))
        return self.base(b, camera) + skill


def demo_config(spec: DemoSpec, image_size: int = 32) -> Config:
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=image_size, base_channels=16, latent_channels=4, downsample=4,
                                    vq_codebook_size=64 if spec.kind == "ar" else 0)
    cfg.action = ActionConfig(embed_dim=32)
    cfg.dynamics = DynamicsConfig(kind=spec.kind, dim=64 if spec.kind == "ar" else 32, depth=2, heads=4, diffusion_steps=6)
    cfg.demo.name = spec.name
    cfg.demo.active_buttons = list(spec.active_buttons)
    return cfg


def build_demo_session(name: str, seed: int = 0) -> tuple[WorldModelSession, DemoSpec]:
    if name not in DEMOS:
        raise KeyError(f"unknown demo {name!r}; choices: {list(DEMOS)}")
    spec = DEMOS[name]
    torch.manual_seed(seed)
    cfg = demo_config(spec)
    tok = Tokenizer(cfg.tokenizer)
    enc = DemoEncoder(ActionEncoder(cfg.action), cfg.action.embed_dim, spec)
    n = cfg.latent_size**2
    if spec.kind == "ar":
        trans: nn.Module = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)
    else:
        trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim)
    return WorldModelSession(cfg, tok, enc, trans), spec
