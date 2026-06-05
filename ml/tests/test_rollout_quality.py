"""Prove the world model SIMULATES: a trained model, given a frame + action,
predicts the next frame with the dot moved in the action's direction, and
multi-step rollouts stay finite + non-degenerate."""

from __future__ import annotations

import torch

from mineworld_wm.config import TokenizerConfig, ActionConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.actions import ActionEncoder
from mineworld_wm.data import MovingDotEnv
from mineworld_wm.transition_ar import ARTransition

SIZE = 32
DIRS = {0: ("up", 0, -1), 1: ("down", 0, 1), 2: ("left", -1, 0), 3: ("right", 1, 0)}


def centroid(frame: torch.Tensor) -> tuple[float, float]:
    """Brightness-weighted (cx, cy) of a (3, H, W) frame."""
    w = frame.mean(0)
    ys = torch.arange(w.shape[0]).float()
    xs = torch.arange(w.shape[1]).float()
    tot = w.sum().clamp_min(1e-6)
    cy = (w.sum(1) * ys).sum() / tot
    cx = (w.sum(0) * xs).sum() / tot
    return float(cx), float(cy)


def build_pairs():
    env = MovingDotEnv(size=SIZE, n_buttons=9, step=4.0)
    pairs = []  # (frame_t, buttons, camera, frame_t1, dir)
    g = torch.Generator().manual_seed(0)
    for _ in range(14):
        x = float(torch.randint(8, SIZE - 8, (1,), generator=g).item())
        y = float(torch.randint(8, SIZE - 8, (1,), generator=g).item())
        for d, (_, dx, dy) in DIRS.items():
            ft = env._render(x, y)
            ft1 = env._render(x + dx * env.step, y + dy * env.step)
            btn = torch.zeros(9)
            btn[d] = 1.0
            pairs.append((ft, btn, torch.zeros(2), ft1, d))
    return pairs


def train_world_model(pairs):
    torch.manual_seed(0)
    tcfg = TokenizerConfig(image_size=SIZE, base_channels=24, latent_channels=4, downsample=4, vq_codebook_size=128)
    acfg = ActionConfig(embed_dim=64)
    dcfg = DynamicsConfig(kind="ar", dim=96, depth=3, heads=4)
    tok = Tokenizer(tcfg)
    enc = ActionEncoder(acfg)
    n = (SIZE // 4) ** 2
    ar = ARTransition(dcfg, n_tokens=n, codebook_size=128, action_dim=64)

    frames = torch.stack([p[0] for p in pairs] + [p[3] for p in pairs])
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for _ in range(300):
        out = tok(frames)
        topt.zero_grad()
        out.loss.backward()
        topt.step()

    with torch.no_grad():
        prev = tok.tokenize(torch.stack([p[0] for p in pairs])).flatten(1)
        nxt = tok.tokenize(torch.stack([p[3] for p in pairs])).flatten(1)
    btn = torch.stack([p[1] for p in pairs])
    cam = torch.stack([p[2] for p in pairs])
    aopt = torch.optim.Adam(list(ar.parameters()) + list(enc.parameters()), lr=2e-3)
    for _ in range(400):
        action = enc(btn, cam)  # fresh graph each step (enc is being trained)
        loss = ar.loss(prev, nxt, action)
        aopt.zero_grad()
        loss.backward()
        aopt.step()
    return tok, enc, ar


def test_world_model_is_action_correct_and_stable():
    pairs = build_pairs()
    tok, enc, ar = train_world_model(pairs)

    correct = 0
    for ft, btn, cam, _ft1, d in pairs:
        with torch.no_grad():
            prev = tok.tokenize(ft.unsqueeze(0)).flatten(1)
            action = enc(btn.unsqueeze(0), cam.unsqueeze(0))
            gen = ar.generate(prev, action)
            grid = int(gen.shape[1] ** 0.5)
            pred = tok.decode_tokens(gen.view(1, grid, grid))[0]
        cx0, cy0 = centroid(ft)
        cx1, cy1 = centroid(pred)
        _, dx, dy = DIRS[d]
        moved = (dx != 0 and (cx1 - cx0) * dx > 0.4) or (dy != 0 and (cy1 - cy0) * dy > 0.4)
        correct += int(moved)
    acc = correct / len(pairs)
    assert acc > 0.7, f"action-direction correctness too low: {acc:.2f}"

    # multi-step stability: roll the model forward and check it doesn't collapse/NaN
    ft, btn, cam, _, _ = pairs[0]
    with torch.no_grad():
        prev = tok.tokenize(ft.unsqueeze(0)).flatten(1)
        action = enc(btn.unsqueeze(0), cam.unsqueeze(0))
        frames = []
        for _ in range(8):
            gen = ar.generate(prev, action)
            grid = int(gen.shape[1] ** 0.5)
            f = tok.decode_tokens(gen.view(1, grid, grid))[0]
            frames.append(f)
            prev = gen
    stacked = torch.stack(frames)
    assert torch.isfinite(stacked).all(), "rollout produced non-finite frames"
    assert stacked.max() > 0.4, "rollout collapsed to dark (dot vanished)"
    assert stacked.std() > 0.01, "rollout is a frozen/degenerate frame"
