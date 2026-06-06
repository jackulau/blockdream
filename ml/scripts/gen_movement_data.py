"""Synthetic per-movement-type data generator.

The VPT contractor data is walking/general only, so the boat/swim/elytra/pig/minecart skill
embeddings never get a gradient — selecting "boat" in the tester does nothing. This generates
per-skill pools with DISTINCT, learnable dynamics (different scroll speed + colour cast +
bob), in the exact on-disk pool format the real trainer consumes (frames (N,H,W,3) uint8,
actions (N,11) float32, skill.txt). It is a stand-in so conditioning is trainable + provable
WITHOUT scarce real footage; real per-skill footage drops into the same layout to scale up.

Usage:
  python scripts/gen_movement_data.py --skills walk,boat,elytra --segments 6 --len 64 --size 64 --out data
Then train conditioned on them:
  python -m mineworld_wm.train_long --pools data/pool_synth_walk,data/pool_synth_boat,...
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

# per-skill dynamics: (scroll rows/step at full-forward, RGB colour cast, vertical-bob amplitude)
SKILL_PARAMS: dict[str, tuple[int, tuple[float, float, float], float]] = {
    "general": (1, (0.60, 0.60, 0.60), 0.0),
    "walk": (1, (0.25, 0.85, 0.30), 0.0),     # green ground, slow
    "sprint": (2, (0.30, 0.95, 0.35), 0.0),   # green, faster
    "jump": (1, (0.35, 0.80, 0.40), 3.0),     # bobs vertically
    "swim": (1, (0.10, 0.55, 0.90), 1.0),     # blue-green, gentle bob
    "boat": (1, (0.15, 0.40, 0.95), 1.5),     # water blue, bobs
    "elytra": (3, (0.75, 0.80, 1.00), 0.0),   # sky, fast
    "pig": (1, (0.85, 0.55, 0.55), 2.0),      # pinkish, bouncy mount
    "minecart": (2, (0.55, 0.55, 0.60), 0.0), # grey rails, steady fast
}

N_BUTTONS = 9
ACTION_DIM = 11  # 9 buttons + 2 camera


def skill_dynamics(prev: np.ndarray, action: np.ndarray, skill: str, t: int) -> np.ndarray:
    """Next frame from prev + action + skill. Forward (button 0) scrolls the scene; the skill
    sets scroll speed, a colour cast, and a vertical bob. Deterministic given inputs."""
    h, w, _ = prev.shape
    speed, cast, bob = SKILL_PARAMS.get(skill, SKILL_PARAMS["general"])
    fwd = float(action[0])
    cam_x = float(action[N_BUTTONS]) if action.shape[0] > N_BUTTONS else 0.0
    rows = max(0, int(round(speed * (0.5 + 1.5 * fwd))))
    nxt = np.roll(prev, rows, axis=0)  # scroll downward (forward motion)
    if cam_x:
        nxt = np.roll(nxt, int(round(cam_x * 4)), axis=1)  # camera pans horizontally
    # blend toward the skill colour cast so the regime is visible + learnable
    cast_arr = np.array(cast, dtype=np.float32) * 255.0
    nxt = (0.82 * nxt.astype(np.float32) + 0.18 * cast_arr).astype(np.uint8)
    # a moving bright stripe gives structure that scrolls (so it's not a flat field)
    y = int((t * (1 + speed) + bob * np.sin(t * 0.5)) % h)
    nxt[y, :, :] = np.array([245, 245, 245], dtype=np.uint8)
    return nxt


def gen_sequence(skill: str, length: int, size: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """A (frames (L,size,size,3) uint8, actions (L,11) float32) clip for one skill."""
    rng = np.random.default_rng(seed)
    frames = np.zeros((length, size, size, 3), dtype=np.uint8)
    actions = np.zeros((length, ACTION_DIM), dtype=np.float32)
    # seed frame: a vertical gradient + the skill cast
    grad = np.linspace(40, 200, size, dtype=np.float32)[:, None, None]
    cur = np.broadcast_to(grad, (size, size, 3)).copy().astype(np.uint8)
    for t in range(length):
        a = np.zeros(ACTION_DIM, dtype=np.float32)
        a[0] = 1.0 if rng.random() < 0.85 else 0.0  # mostly moving forward
        a[N_BUTTONS] = float(rng.uniform(-0.3, 0.3))  # small camera pan
        cur = skill_dynamics(cur, a, skill, t)
        frames[t] = cur
        actions[t] = a
    return frames, actions


def write_pool(out_root: str, skill: str, segments: int, length: int, size: int) -> str:
    out = Path(out_root) / f"pool_synth_{skill}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "skill.txt").write_text(skill)
    for i in range(segments):
        frames, actions = gen_sequence(skill, length, size, seed=1000 * hash_skill(skill) + i)
        np.savez_compressed(out / f"seg_{i:05d}.npz", frames=frames, actions=actions)
    return str(out)


def hash_skill(skill: str) -> int:
    return abs(sum(ord(c) for c in skill)) % 997


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skills", default="walk,boat,elytra", help="comma-separated movement types")
    ap.add_argument("--segments", type=int, default=6)
    ap.add_argument("--len", type=int, default=64, dest="length")
    ap.add_argument("--size", type=int, default=64)
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    for skill in [s.strip() for s in args.skills.split(",") if s.strip()]:
        if skill not in SKILL_PARAMS:
            print(f"  ! unknown skill {skill!r} — skipping (known: {list(SKILL_PARAMS)})")
            continue
        path = write_pool(args.out, skill, args.segments, args.length, args.size)
        print(f"  ✓ {skill:9s} → {path} ({args.segments}×{args.length} frames @ {args.size}px)")


if __name__ == "__main__":
    main()
