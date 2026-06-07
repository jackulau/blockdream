"""Skill-conditioned serving: the movement type can be set live and conditions
the rollout (plumbing test with an untrained conditioned model)."""

from __future__ import annotations

import torch

from blockdream_wm.config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.movement import SkillRealEncoder, N_MOVEMENT, skill_id
from blockdream_wm.transition_ar import ARTransition
from blockdream_wm.serve import WorldModelSession, RolloutServer


def _conditioned_session() -> WorldModelSession:
    torch.manual_seed(0)
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=64)
    cfg.action = ActionConfig(embed_dim=32)
    cfg.dynamics = DynamicsConfig(kind="ar", dim=32, depth=2, heads=4)
    tok = Tokenizer(cfg.tokenizer)
    enc = SkillRealEncoder(cfg.action, N_MOVEMENT)
    n = cfg.latent_size**2
    ar = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=64, action_dim=32)
    return WorldModelSession(cfg, tok, enc, ar)


def test_skill_message_sets_movement_type():
    server = RolloutServer(_conditioned_session())
    out = server.handle({"type": "skill", "skill": "elytra"})
    assert out["type"] == "ok" and out["skill"] == "elytra"
    assert server.session.skill == skill_id("elytra")


def test_action_carries_skill_and_generates_frame():
    server = RolloutServer(_conditioned_session())
    server.handle({"type": "reset"})
    out = server.handle({"type": "action", "skill": "boat", "buttons": [1, 0, 0, 0, 0, 0, 0, 0, 0], "camera": [0, 0]})
    assert out["type"] == "frame" and out["shape"] == [3, 32, 32]
    assert server.session.skill == skill_id("boat")


def test_skill_changes_the_generated_rollout():
    # same prev state + action, different movement type → different generated tokens
    s = _conditioned_session()
    s.reset()
    s.skill = skill_id("walk")
    f_walk = s.step(torch.tensor([1.0, 0, 0, 0, 0, 0, 0, 0, 0]), torch.zeros(2)).frame
    s.reset()
    s.skill = skill_id("elytra")
    f_elytra = s.step(torch.tensor([1.0, 0, 0, 0, 0, 0, 0, 0, 0]), torch.zeros(2)).frame
    assert not torch.allclose(f_walk, f_elytra)
