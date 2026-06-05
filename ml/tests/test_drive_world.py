"""The trained driving world model obeys physics: steer-left predicts a higher
yaw-rate than steer-right, and recursive rollout stays finite + non-degenerate."""

from __future__ import annotations

import numpy as np
import torch

from mineworld_wm.config import TokenizerConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.drive.sim import DriveSim
from mineworld_wm.drive.physics import CarState
from mineworld_wm.drive.transition import DriveTransition

LEFT = [1.0, 0.3, 0.0]
RIGHT = [-1.0, 0.3, 0.0]
STRAIGHT = [0.0, 0.3, 0.0]


def _controlled_pairs(n_states=70, seed=0):
    sim = DriveSim(seed=seed)
    rng = np.random.default_rng(seed)
    rgb, lid, tel, ctl, nlid, ntel = [], [], [], [], [], []
    for _ in range(n_states):
        sim.reset(int(rng.integers(0, len(sim.centerline))))
        sim.state.vx = float(rng.uniform(5, 12))
        base = CarState(**vars(sim.state))
        for a in (LEFT, RIGHT, STRAIGHT):
            sim.state = CarState(**vars(base))
            o0 = sim.observation()
            sim.step(*a)
            o1 = sim.observation()
            rgb.append(o0["rgb"]); lid.append(o0["lidar"]); tel.append(o0["telemetry"]); ctl.append(np.array(a, np.float32))
            nlid.append(o1["lidar"]); ntel.append(o1["telemetry"])
    f = lambda L: torch.from_numpy(np.stack(L)).float()
    return f(rgb), f(lid), f(tel), f(ctl), f(nlid), f(ntel)


def test_world_model_obeys_turning_physics_and_is_stable():
    torch.manual_seed(0)
    rgb, lid, tel, ctl, nlid, ntel = _controlled_pairs()
    rgb = rgb / 255.0

    tok = Tokenizer(TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=128))
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for _ in range(120):
        idx = torch.randint(0, rgb.shape[0], (16,))
        out = tok(rgb[idx]); topt.zero_grad(); out.loss.backward(); topt.step()
    with torch.no_grad():
        toks = tok.tokenize(rgb).flatten(1)

    trans = DriveTransition(DynamicsConfig(kind="ar", dim=64, depth=2, heads=4), n_tokens=64, codebook_size=128, n_lidar=32, n_telemetry=6)
    # next-frame tokens are not needed for the physics head, but train the full loss
    nxt_tokens = torch.cat([toks[1:], toks[:1]])  # dummy alignment (RGB not under test)
    opt = torch.optim.Adam(trans.parameters(), lr=2e-3)
    for _ in range(400):
        b = torch.randint(0, toks.shape[0], (24,))
        loss, _ = trans.loss(toks[b], nxt_tokens[b], lid[b], tel[b], ctl[b], nlid[b], ntel[b])
        opt.zero_grad(); loss.backward(); opt.step()

    # physics fidelity: same state, steer-left vs steer-right → yaw-rate (telemetry idx 2)
    s = 5  # a test state index
    c = lambda a: trans._fuse(torch.tensor([a]), lid[s:s+1], tel[s:s+1])
    with torch.no_grad():
        r_left = trans.telemetry_head(c(LEFT))[0, 2].item()
        r_right = trans.telemetry_head(c(RIGHT))[0, 2].item()
    assert r_left > r_right + 0.01, f"left yaw-rate {r_left:.3f} not > right {r_right:.3f}"

    # recursive stability: 8 self-fed steps stay finite + telemetry bounded
    pt, pl, pte = toks[s:s+1], lid[s:s+1], tel[s:s+1]
    for _ in range(8):
        pt, pl, pte = trans.step(pt, pl, pte, torch.tensor([STRAIGHT]))
        assert torch.isfinite(pl).all() and torch.isfinite(pte).all()
        assert pte.abs().max() < 50  # not exploding
