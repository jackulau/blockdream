import torch

from blockdream_wm.config import ActionConfig
from blockdream_wm.movement import MOVEMENT_TYPES, SKILL_ID, skill_id, SkillRealEncoder, N_MOVEMENT


def test_taxonomy_covers_all_movement_types():
    for t in ["walk", "sprint", "jump", "swim", "boat", "elytra", "pig", "minecart"]:
        assert t in MOVEMENT_TYPES
    assert skill_id("elytra") == SKILL_ID["elytra"]
    assert skill_id("nonsense") == 0  # unknown → general


def test_skill_encoder_conditions_on_movement_type():
    cfg = ActionConfig(embed_dim=32)
    enc = SkillRealEncoder(cfg, N_MOVEMENT)
    b = torch.ones(4, cfg.n_buttons)
    c = torch.zeros(4, 2)
    walk = enc(b, c, skill=skill_id("walk"))
    elytra = enc(b, c, skill=skill_id("elytra"))
    assert walk.shape == (4, 32)
    # same action, different movement type → different conditioned embedding
    assert not torch.allclose(walk, elytra)


def test_default_skill_used_when_none():
    cfg = ActionConfig(embed_dim=32)
    enc = SkillRealEncoder(cfg, N_MOVEMENT)
    enc.default_skill = skill_id("boat")
    b = torch.ones(2, cfg.n_buttons)
    c = torch.zeros(2, 2)
    assert torch.allclose(enc(b, c), enc(b, c, skill=skill_id("boat")))
