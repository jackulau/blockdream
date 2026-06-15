"""CAST the world model's dream INTO Minecraft - record a WM rollout and emit a vanilla Java datapack
ANIMATION that plays the dream as a block-wall in-world. This is the offline counterpart to the live
Fabric bridge (mods/java-fabric): no mod, no server - just drop the datapack and run /function.

Pipeline: roll the skill-conditioned WM N steps (held-forward by default) → save each generated frame →
ffmpeg into an mp4 → the `blockdream` CLI quantizes every frame to Minecraft map-colors and emits a
frame-by-frame command-block datapack (`--target datapack`). The result is a droppable .zip that
animates the WM's dream on a block wall.

    ml/.venv/bin/python scripts/cast_wm_to_datapack.py --skill walk --steps 24 --out /tmp/wmcast
    # → /tmp/wmcast/<...>.zip  (drop in <world>/datapacks, /reload, /function blockdream:setup, then play)
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import torch
from PIL import Image

from blockdream_wm.serve import load_real_checkpoint
from blockdream_wm.movement import skill_id, MOVEMENT_TYPES


def preflight_errors(checkpoint: str | Path) -> list[str]:
    """Check external prerequisites up front. Returns one actionable line per missing piece
    (empty list = all good) so main() can fail fast instead of dying mid-pipeline."""
    errors: list[str] = []
    if shutil.which("ffmpeg") is None:
        errors.append(
            "ffmpeg not found on PATH - install it (macOS: `brew install ffmpeg`; "
            "Debian/Ubuntu: `apt install ffmpeg`) so frames can be encoded to mp4"
        )
    if shutil.which("npx") is None:
        errors.append(
            "npx not found on PATH - install Node.js >= 18 (https://nodejs.org or `brew install node`); "
            "the datapack emitter runs via `npx tsx packages/cli/src/index.ts`"
        )
    ckpt = Path(checkpoint)
    if not ckpt.is_file():
        errors.append(
            f"checkpoint not found: {ckpt} - run from ml/ so the default "
            "`runs/skills_real/latest.pt` resolves, or pass --checkpoint <path> "
            "(train one with scripts/train_real.sh if you have none)"
        )
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("cast_wm_to_datapack")
    ap.add_argument("--checkpoint", default="runs/skills_real/latest.pt")
    ap.add_argument("--skill", default="walk", choices=MOVEMENT_TYPES)
    ap.add_argument("--steps", type=int, default=24, help="rollout length = animation frames")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--out", default="/tmp/wmcast")
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args(argv)

    errors = preflight_errors(args.checkpoint)
    if errors:
        for e in errors:
            print(f"[cast] preflight: {e}", file=sys.stderr)
        return 1

    out = Path(args.out)
    frames_dir = out / "_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # 1) roll the WM out under the chosen movement type (held forward)
    session = load_real_checkpoint(args.checkpoint, device=args.device)
    session.skill = skill_id(args.skill)
    session.reset()
    buttons = torch.zeros(9)
    buttons[0] = 1.0  # forward
    camera = torch.zeros(2)
    for i in range(args.steps):
        frame = session.step(buttons, camera).frame  # (3,H,W) in [0,1]
        arr = (frame.clamp(0, 1) * 255).round().byte().permute(1, 2, 0).cpu().numpy()
        Image.fromarray(arr, mode="RGB").save(frames_dir / f"f{i:05d}.png")
    print(f"[cast] rolled {args.steps} WM frames for skill={args.skill}")

    # 2) frames → mp4 (the CLI decodes it with ffmpeg)
    mp4 = out / "dream.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-framerate", str(args.fps), "-i", str(frames_dir / "f%05d.png"),
         "-pix_fmt", "yuv420p", str(mp4)],
        check=True, capture_output=True,
    )

    # 3) mp4 → vanilla Java datapack animation (block-wall, map-colour quantized, frame-by-frame)
    repo = Path(__file__).resolve().parents[2]  # ml/scripts/ -> ml/ -> repo root
    cli = repo / "packages" / "cli" / "src" / "index.ts"
    r = subprocess.run(
        ["npx", "tsx", str(cli), "render", str(mp4), "--target", "datapack", "--out", str(out)],
        cwd=repo,
    )
    if r.returncode != 0:
        print("[cast] datapack emit FAILED")
        return 1
    zips = list(out.glob("*.zip"))
    print(f"[cast] WM dream cast → {zips[0] if zips else '(no zip - check --out)'}")
    return 0 if zips else 1


if __name__ == "__main__":
    sys.exit(main())
