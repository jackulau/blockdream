"""Build a REAL driving token pool from commaVQ — the driving analogue of import_mineflayer.py.

commaVQ (`commaai/commavq`) is ~100k segments of REAL comma.ai dashcam video, pre-tokenized with
comma's VQ-VAE (128 tokens/frame, codebook 1024) + ego pose. This discovers (token, pose) segment
pairs in a downloaded commaVQ directory and writes a real driving pool (roll_*.npz + source.txt),
from which `train_drive_real.sh` trains the served real driving world model. ZERO synthetic data.

Download a small shard first (single-file granularity keeps it tiny):
    ml/.venv/bin/python -c "from huggingface_hub import hf_hub_download as d; \
        d('commaai/commavq','val.zip',repo_type='dataset',local_dir='ml/data/commavq_raw')"
or a directory shard:
    huggingface-cli download commaai/commavq --repo-type dataset --include 'data_0_to_2500/*' \
        --local-dir ml/data/commavq_raw

Then:
    ml/.venv/bin/python scripts/collect_real_drive.py --commavq-dir ml/data/commavq_raw \
        --out ml/data/drive_real_pool --max-segments 4
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from blockdream_wm.drive.commavq import build_real_pool, TOKENS_PER_FRAME


def _looks_like_tokens(p: Path) -> bool:
    """A commaVQ token file reshapes to (T, 128) — last dims (8,16) or a trailing 128."""
    try:
        a = np.load(p, mmap_mode="r")
    except Exception:
        return False
    if a.ndim >= 2 and int(np.prod(a.shape[1:])) == TOKENS_PER_FRAME:
        return True
    return a.ndim >= 3 and a.shape[-2:] == (8, 16)


def discover_segments(root: Path) -> list[tuple[str, str | None]]:
    """Find (token_npy, pose_npy) pairs. Supports two layouts:
       • per-segment dir: <seg>/token.npy + <seg>/pose.npy
       • flat: <name>.npy (tokens) + <name>_pose.npy / <name>.pose.npy"""
    segs: list[tuple[str, str | None]] = []
    # per-segment dirs
    for tok in sorted(root.rglob("token*.npy")):
        if tok.name.startswith("pose") or "pose" in tok.name:
            continue
        pose = None
        for cand in (tok.with_name("pose.npy"), tok.parent / "pose.npy",
                     tok.with_name(tok.stem + "_pose.npy"), tok.with_name(tok.stem + ".pose.npy")):
            if cand.exists():
                pose = str(cand)
                break
        if _looks_like_tokens(tok):
            segs.append((str(tok), pose))
    # flat fallback: any *.npy that looks like tokens and isn't already captured
    seen = {t for t, _ in segs}
    for tok in sorted(root.rglob("*.npy")):
        if str(tok) in seen or "pose" in tok.name.lower():
            continue
        if _looks_like_tokens(tok):
            pose = None
            for cand in (tok.with_name(tok.stem + "_pose.npy"), tok.with_name(tok.stem + ".pose.npy"),
                         tok.parent / "pose.npy"):
                if cand.exists():
                    pose = str(cand)
                    break
            segs.append((str(tok), pose))
    return segs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("collect_real_drive")
    ap.add_argument("--commavq-dir", required=True, help="downloaded commaVQ directory")
    ap.add_argument("--out", default="ml/data/drive_real_pool")
    ap.add_argument("--max-segments", type=int, default=0, help="cap segments (0 = all found)")
    ap.add_argument("--max-frames-per-seg", type=int, default=0, help="cap frames/segment (0 = all)")
    args = ap.parse_args(argv)

    root = Path(args.commavq_dir)
    if not root.exists():
        raise SystemExit(f"commaVQ dir not found: {root} — download a shard first (see this file's header)")
    segs = discover_segments(root)
    with_pose = [s for s in segs if s[1]]
    if not with_pose:
        raise SystemExit(
            f"found {len(segs)} token file(s) but none with a matching pose.npy in {root}. "
            "Real control needs ego pose — download a commaVQ subset that includes pose, or place "
            "pose.npy beside each token file.")
    if args.max_segments:
        with_pose = with_pose[: args.max_segments]
    n = build_real_pool(with_pose, args.out, max_frames_per_seg=args.max_frames_per_seg)
    print(f"[collect_real_drive] built {n} REAL rollouts → {args.out}")
    return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
