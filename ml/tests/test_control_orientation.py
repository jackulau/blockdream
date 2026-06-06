"""Full control representation: absolute look orientation (yaw/pitch/roll) conditioning,
on top of the VPT buttons + relative camera. Verifies the new channel changes the action
embedding when enabled, is a no-op (and adds no parameters) when disabled (so existing
checkpoints load unchanged), and threads through the skill-conditioned encoder + server."""

import torch

from mineworld_wm.config import ActionConfig
from mineworld_wm.actions import ActionEncoder
from mineworld_wm.movement import SkillRealEncoder, skill_id


def _buttons_camera(b=2, n=9):
    return torch.zeros(b, n), torch.zeros(b, 2)


def test_orientation_off_is_backward_compatible():
    enc = ActionEncoder(ActionConfig())  # orientation defaults off
    keys = set(enc.state_dict().keys())
    assert not any("orient" in k for k in keys), "no orientation params when disabled"
    buttons, camera = _buttons_camera()
    out = enc(buttons, camera)
    assert out.shape == (2, ActionConfig().embed_dim)
    # passing an orientation when disabled is ignored (same output)
    ori = torch.randn(2, 3)
    assert torch.allclose(out, enc(buttons, camera, ori))


def test_orientation_on_adds_a_projection_and_changes_output():
    cfg = ActionConfig(orientation=True)
    enc = ActionEncoder(cfg)
    assert any("orient_proj" in k for k in enc.state_dict().keys())
    buttons, camera = _buttons_camera()
    base = enc(buttons, camera)  # orientation None → treated as zeros
    looking_left = enc(buttons, camera, torch.tensor([[-1.0, 0.0, 0.0]] * 2))
    looking_right = enc(buttons, camera, torch.tensor([[1.0, 0.0, 0.0]] * 2))
    assert not torch.allclose(looking_left, looking_right), "yaw must change the embedding"
    assert not torch.allclose(base, looking_left), "absolute pose must matter"


def test_orientation_none_equals_zero_when_enabled():
    cfg = ActionConfig(orientation=True)
    enc = ActionEncoder(cfg)
    buttons, camera = _buttons_camera()
    z = torch.zeros(2, 3)
    assert torch.allclose(enc(buttons, camera, None), enc(buttons, camera, z))


def test_skill_encoder_threads_orientation_and_skill():
    cfg = ActionConfig(orientation=True)
    enc = SkillRealEncoder(cfg)
    buttons, camera = _buttons_camera()
    walk = enc(buttons, camera, skill=skill_id("walk"), orientation=torch.tensor([[0.5, 0.0, 0.0]] * 2))
    boat = enc(buttons, camera, skill=skill_id("boat"), orientation=torch.tensor([[0.5, 0.0, 0.0]] * 2))
    same_skill_diff_pose = enc(buttons, camera, skill=skill_id("walk"), orientation=torch.tensor([[-0.5, 0.0, 0.0]] * 2))
    assert not torch.allclose(walk, boat), "skill must change the conditioning"
    assert not torch.allclose(walk, same_skill_diff_pose), "orientation must change the conditioning"


def test_server_accepts_orientation_message():
    # the server path should accept (and use) an optional orientation in an action message
    from mineworld_wm.config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
    from mineworld_wm.tokenizer import Tokenizer
    from mineworld_wm.transition_ar import ARTransition
    from mineworld_wm.serve import WorldModelSession, RolloutServer

    torch.manual_seed(0)
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=64)
    cfg.action = ActionConfig(embed_dim=32, orientation=True)  # orientation conditioning ON
    cfg.dynamics = DynamicsConfig(kind="ar", dim=32, depth=2, heads=4)
    tok = Tokenizer(cfg.tokenizer)
    enc = SkillRealEncoder(cfg.action)
    n = cfg.latent_size**2
    ar = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=64, action_dim=32)
    server = RolloutServer(WorldModelSession(cfg, tok, enc, ar))
    server.handle({"type": "reset"})
    out = server.handle({"type": "action", "buttons": [1, 0, 0, 0, 0, 0, 0, 0, 0],
                         "camera": [0.0, 0.0], "orientation": [0.3, -0.2, 0.0]})
    assert out["type"] == "frame"
    # and it still works WITHOUT an orientation field (optional)
    out2 = server.handle({"type": "action", "buttons": [0] * 9, "camera": [0.0, 0.0]})
    assert out2["type"] == "frame"
