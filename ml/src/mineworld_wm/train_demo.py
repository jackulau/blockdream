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
from .data import MovingDotEnv

DIRS = {0: (0, -1), 1: (0, 1), 2: (-1, 0), 3: (1, 0)}  # up/down/left/right deltas


def centroid(frame: torch.Tensor) -> tuple[float, float]:
    w = frame.mean(0)
    ys = torch.arange(w.shape[0]).float()
    xs = torch.arange(w.shape[1]).float()
    tot = w.sum().clamp_min(1e-6)
    return float((w.sum(0) * xs).sum() / tot), float((w.sum(1) * ys).sum() / tot)


def build_pairs(size: int, n_buttons: int, n_pos: int, step: float, seed: int):
    env = MovingDotEnv(size=size, n_buttons=n_buttons, step=step)
    g = torch.Generator().manual_seed(seed)
    pairs = []
    for _ in range(n_pos):
        x = float(torch.randint(8, size - 8, (1,), generator=g).item())
        y = float(torch.randint(8, size - 8, (1,), generator=g).item())
        for d, (dx, dy) in DIRS.items():
            ft = env._render(x, y)
            ft1 = env._render(x + dx * env.step, y + dy * env.step)
            btn = torch.zeros(n_buttons)
            btn[d] = 1.0
            pairs.append((ft, btn, torch.zeros(2), ft1, d))
    return pairs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.train_demo")
    ap.add_argument("--demo", default="walking")
    ap.add_argument("--kind", default="ar", choices=["ar", "diffusion"])
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--tok-steps", type=int, default=300)
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

    # 3) action-correctness check via the live session
    correct = 0
    for ft, b, c, _ft1, d in pairs:
        session.reset(ft)
        res = session.step(b, c)
        cx0, cy0 = centroid(ft)
        cx1, cy1 = centroid(res.frame)
        dx, dy = DIRS[d]
        moved = (dx != 0 and (cx1 - cx0) * dx > 0.3) or (dy != 0 and (cy1 - cy0) * dy > 0.3)
        correct += int(moved)
    acc = correct / len(pairs)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"config": cfg.to_dict(), "demo": args.demo, "kind": args.kind,
                "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": trans.state_dict()}, out)
    print(f"[train_demo] {args.demo}/{args.kind}  loss {first:.3f}->{last:.3f}  action-correct {acc:.2f}  → {out}")
    return 0 if acc > 0.6 else 1


if __name__ == "__main__":
    raise SystemExit(main())
