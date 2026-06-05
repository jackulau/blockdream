import base64

import torch

from mineworld_wm.config import Config, TokenizerConfig, ActionConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.actions import ActionEncoder
from mineworld_wm.transition_ar import ARTransition
from mineworld_wm.transition_diffusion import LatentDiffusionTransition
from mineworld_wm.serve import WorldModelSession, RolloutServer, frame_to_png_b64


def _cfg(kind: str) -> Config:
    cfg = Config()
    cfg.tokenizer = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4,
                                    vq_codebook_size=64 if kind == "ar" else 0)
    cfg.action = ActionConfig(embed_dim=32)
    cfg.dynamics = DynamicsConfig(kind=kind, dim=32, depth=2, heads=4, diffusion_steps=4)
    return cfg


def _session(kind: str) -> WorldModelSession:
    torch.manual_seed(0)
    cfg = _cfg(kind)
    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n = cfg.latent_size**2
    if kind == "ar":
        trans = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)
    else:
        trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim)
    return WorldModelSession(cfg, tok, enc, trans)


def test_png_encode_roundtrips_shape():
    b64 = frame_to_png_b64(torch.rand(3, 32, 32))
    raw = base64.b64decode(b64)
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"  # PNG magic


def test_ar_rollout_roundtrip_action_to_frame():
    server = RolloutServer(_session("ar"))
    reset = server.handle({"type": "reset"})
    assert reset["type"] == "frame" and reset["shape"] == [3, 32, 32]
    out = server.handle({"type": "action", "buttons": [1, 0, 0, 0, 0, 0, 0, 0, 0], "camera": [0.2, -0.1]})
    assert out["type"] == "frame"
    assert out["step"] == 1
    assert out["shape"] == [3, 32, 32]
    assert base64.b64decode(out["png_b64"])[:4] == b"\x89PNG"


def test_diffusion_rollout_roundtrip_and_state_advances():
    server = RolloutServer(_session("diffusion"))
    server.handle({"type": "reset"})
    a = server.handle({"type": "action", "camera": [0.5, 0.5]})
    b = server.handle({"type": "action", "camera": [-0.5, 0.5]})
    assert a["step"] == 1 and b["step"] == 2
    assert a["shape"] == [3, 32, 32]


def test_unknown_message_is_error():
    server = RolloutServer(_session("ar"))
    assert server.handle({"type": "bogus"})["type"] == "error"
