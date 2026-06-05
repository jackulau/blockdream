import base64

import torch

from mineworld_wm.config import TokenizerConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.drive.transition import DriveTransition
from mineworld_wm.drive.serve import DriveSession, DriveServer
from mineworld_wm.drive.sim import DriveSim


def _tiny_checkpoint() -> dict:
    torch.manual_seed(0)
    tcfg = TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=64)
    dcfg = DynamicsConfig(kind="ar", dim=32, depth=2, heads=4)
    tok = Tokenizer(tcfg)
    trans = DriveTransition(dcfg, n_tokens=64, codebook_size=64, n_lidar=32, n_telemetry=6)
    sim = DriveSim()
    o = sim.observation()
    rgb = torch.from_numpy(o["rgb"]).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        init_tokens = tok.tokenize(rgb).flatten(1)[0]
    return {
        "tokenizer_cfg": vars(tcfg), "dynamics_cfg": vars(dcfg),
        "n_lidar": 32, "n_telemetry": 6, "image": 64, "downsample": 8, "codebook": 64,
        "tokenizer": tok.state_dict(), "transition": trans.state_dict(),
        "init_tokens": init_tokens, "init_lidar": torch.from_numpy(o["lidar"]), "init_telemetry": torch.from_numpy(o["telemetry"]),
    }


def test_drive_server_streams_multimodal_frame():
    server = DriveServer(DriveSession(_tiny_checkpoint()))
    reset = server.handle({"type": "reset"})
    assert reset["type"] == "frame" and reset["step"] == 0
    assert base64.b64decode(reset["rgb_png_b64"])[:4] == b"\x89PNG"
    assert len(reset["lidar"]) == 32
    assert len(reset["telemetry"]) == 6

    out = server.handle({"type": "action", "control": [0.5, 0.4, 0.0]})  # steer + throttle
    assert out["type"] == "frame" and out["step"] == 1
    assert base64.b64decode(out["rgb_png_b64"])[:4] == b"\x89PNG"
    assert len(out["lidar"]) == 32 and len(out["telemetry"]) == 6


def test_unknown_message_errors():
    server = DriveServer(DriveSession(_tiny_checkpoint()))
    assert server.handle({"type": "nope"})["type"] == "error"
