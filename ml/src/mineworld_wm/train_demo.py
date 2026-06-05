"""Train one demo to be visibly action-responsive and save a checkpoint the
WebSocket server loads. Toy/CPU scale on the deterministic MovingDot world — the
served model genuinely moves the dot in the commanded direction.

    python -m mineworld_wm.train_demo --demo walking --kind ar --out checkpoints/walking.pt
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

from .demos import build_demo_session
from .data import demo_env

DIRS = {0: (0, -1), 1: (0, 1), 2: (-1, 0), 3: (1, 0)}  # up/down/left/right deltas


def centroid(frame: torch.Tensor) -> tuple[float, float]:
    w = frame.mean(0)
    ys = torch.arange(w.shape[0]).float()
    xs = torch.arange(w.shape[1]).float()
    tot = w.sum().clamp_min(1e-6)
    return float((w.sum(0) * xs).sum() / tot), float((w.sum(1) * ys).sum() / tot)


def build_pairs(size: int, n_buttons: int, n_pos: int, step: float, seed: int):
    """Dense, step-aligned coverage so the free-running rollout never leaves the
    trained distribution (avoids autoregressive drift). The agent lives on a grid
    of positions spaced `step` apart and is clamped to a padded interior — so it
    slides to a wall and stays there (a trained, stable state) instead of drifting.
    """
    env = demo_env(size=size, n_buttons=n_buttons, step=step)
    pad = 8
    s = int(step)
    lo, hi = pad, size - pad
    grid = list(range(lo, hi + 1, s))  # exactly the centers the rollout can occupy

    def clamp(v: int) -> int:
        return max(lo, min(hi, v))

    pairs = []
    for x in grid:
        for y in grid:
            for d, (dx, dy) in DIRS.items():
                nx = clamp(x + dx * s)
                ny = clamp(y + dy * s)
                ft = env._render(x, y)
                ft1 = env._render(nx, ny)
                btn = torch.zeros(n_buttons)
                btn[d] = 1.0
                pairs.append((ft, btn, torch.zeros(2), ft1, d))
    return pairs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.train_demo")
    ap.add_argument("--demo", default="walking")
    ap.add_argument("--kind", default="ar", choices=["ar", "diffusion"])
    ap.add_argument("--steps", type=int, default=600)
    ap.add_argument("--tok-steps", type=int, default=600)
    ap.add_argument("--out", default="checkpoints/walking.pt")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    session, spec = build_demo_session(args.demo, seed=args.seed, kind=args.kind)
    cfg = session.cfg
    size = cfg.tokenizer.image_size
    tok, enc, trans = session.tok, session.enc, session.trans

    pairs = build_pairs(size, cfg.action.n_buttons, n_pos=14, step=4.0, seed=args.seed + 1)
    frames = torch.stack([p[0] for p in pairs] + [p[3] for p in pairs])

    # 1) tokenizer reconstruction
    topt = torch.optim.Adam(tok.parameters(), lr=2e-3)
    for _ in range(args.tok_steps):
        out = tok(frames)
        topt.zero_grad()
        out.loss.backward()
        topt.step()

    # 2) transition + action encoder
    btn = torch.stack([p[1] for p in pairs])
    cam = torch.stack([p[2] for p in pairs])
    if args.kind == "ar":
        with torch.no_grad():
            prev = tok.tokenize(torch.stack([p[0] for p in pairs])).flatten(1)
            nxt = tok.tokenize(torch.stack([p[3] for p in pairs])).flatten(1)
    else:
        with torch.no_grad():
            prev = tok.encode(torch.stack([p[0] for p in pairs]))
            nxt = tok.encode(torch.stack([p[3] for p in pairs]))

    opt = torch.optim.Adam(list(trans.parameters()) + list(enc.parameters()), lr=2e-3)
    first = last = None
    for _ in range(args.steps):
        action = enc(btn, cam)
        loss = trans.loss(prev, nxt, action) if args.kind == "ar" else trans.loss(nxt, prev, action)
        opt.zero_grad()
        loss.backward()
        opt.step()
        if first is None:
            first = loss.item()
        last = loss.item()

    # 3) action-correctness + crispness check via the live session
    correct = 0
    gen_err = 0.0
    with torch.no_grad():
        recon_mse = torch.nn.functional.mse_loss(tok(frames).recon, frames).item()
    for ft, b, c, ft1, d in pairs:
        session.reset(ft)
        res = session.step(b, c)
        cx0, cy0 = centroid(ft)
        cx1, cy1 = centroid(res.frame)
        dx, dy = DIRS[d]
        moved = (dx != 0 and (cx1 - cx0) * dx > 0.3) or (dy != 0 and (cy1 - cy0) * dy > 0.3)
        correct += int(moved)
        gen_err += torch.nn.functional.l1_loss(res.frame, ft1).item()
    acc = correct / len(pairs)
    gen_err /= len(pairs)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"config": cfg.to_dict(), "demo": args.demo, "kind": args.kind,
                "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": trans.state_dict()}, out)
    print(f"[train_demo] {args.demo}/{args.kind}  trans-loss {first:.3f}->{last:.3f}  "
          f"recon-mse {recon_mse:.4f}  gen-frame-L1 {gen_err:.4f}  action-correct {acc:.2f}  → {out}")
    return 0 if acc > 0.6 else 1


if __name__ == "__main__":
    raise SystemExit(main())
