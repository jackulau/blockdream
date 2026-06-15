"""Build a REAL driving token pool from commaVQ - the driving analogue of import_mineflayer.py.

commaVQ (`commaai/commavq`, MIT) is ~100k segments of REAL comma.ai dashcam video, pre-tokenized
with comma's VQ-VAE (128 tokens/frame, codebook 1024) + comma's logged ego MOTION pose
(`<seg>.pose.npy`, (1200,6) = [v_fwd, v_lat, v_up, ω_roll, ω_pitch, ω_yaw]). This either streams a
tiny real sample straight from HuggingFace (no multi-GB download - early-abort after N segments) or
reads an already-downloaded commaVQ directory, then writes a real driving pool (roll_*.npz +
source.txt 'commavq-real'). ZERO synthetic data: control/telemetry are derived from comma's real log.

Stream a tiny real sample (recommended - pulls only a few MB):
    ml/.venv/bin/python scripts/collect_real_drive.py --stream-hf --max-segments 6 \
        --out ml/data/drive_real_pool

Or read a full shard you downloaded yourself:
    huggingface-cli download commaai/commavq --repo-type dataset --include 'data-0000.tar.gz' \
        --local-dir ml/data/commavq_raw     # then extract the .tar.gz
    ml/.venv/bin/python scripts/collect_real_drive.py --commavq-dir ml/data/commavq_raw \
        --out ml/data/drive_real_pool --max-segments 6
"""

from __future__ import annotations

import argparse
import io
import tarfile
import urllib.request
from pathlib import Path

import numpy as np

from blockdream_wm.drive.commavq import build_real_pool, TOKENS_PER_FRAME

HF_SHARD_URL = "https://huggingface.co/datasets/commaai/commavq/resolve/main/{shard}"


def _looks_like_tokens(p: Path) -> bool:
    """A commaVQ token file reshapes to (T, 128) - last dims (8,16) or a trailing 128."""
    try:
        a = np.load(p, mmap_mode="r")
    except Exception:
        return False
    if a.ndim >= 2 and int(np.prod(a.shape[1:])) == TOKENS_PER_FRAME:
        return True
    return a.ndim >= 3 and a.shape[-2:] == (8, 16)


def _pose_for(tok: Path) -> str | None:
    """Find the pose file beside a token file across commaVQ's layouts."""
    cands = []
    if tok.name.endswith(".token.npy"):                       # commaVQ native: X.token.npy → X.pose.npy
        cands.append(tok.with_name(tok.name[: -len(".token.npy")] + ".pose.npy"))
    cands += [tok.with_name("pose.npy"), tok.parent / "pose.npy",
              tok.with_name(tok.stem + "_pose.npy"), tok.with_name(tok.stem + ".pose.npy")]
    for c in cands:
        if c.exists():
            return str(c)
    return None


def discover_segments(root: Path) -> list[tuple[str, str | None]]:
    """Find (token_npy, pose_npy) pairs across commaVQ layouts (native `X.token.npy`/`X.pose.npy`,
    per-segment dirs, or flat `name.npy` + `name_pose.npy`)."""
    segs: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for tok in sorted(root.rglob("*.npy")):
        name = tok.name.lower()
        if "pose" in name:                                    # pose file, not a token file
            continue
        if str(tok) in seen or not _looks_like_tokens(tok):
            continue
        seen.add(str(tok))
        segs.append((str(tok), _pose_for(tok)))
    return segs


def stream_hf_sample(out_dir: Path, max_segments: int, shard: str = "data-0000.tar.gz",
                     max_frames: int = 0) -> list[tuple[str, str | None]]:
    """Stream the first `max_segments` REAL (token, pose) pairs out of a commaVQ shard tar.gz on
    HuggingFace and write them as raw .npy under out_dir - early-aborting the HTTP stream so only a
    few MB are pulled (each segment ≈ 0.3 MB tokens + 0.03 MB pose), never the full 500 MB shard."""
    out_dir.mkdir(parents=True, exist_ok=True)
    url = HF_SHARD_URL.format(shard=shard)
    req = urllib.request.Request(url, headers={"User-Agent": "mineworld-commavq/1.0"})
    pending: dict[str, dict] = {}
    done: list[tuple[str, str | None]] = []
    with urllib.request.urlopen(req, timeout=180) as resp:
        tf = tarfile.open(fileobj=resp, mode="r|gz")
        for m in tf:
            if not (m.name.endswith(".token.npy") or m.name.endswith(".pose.npy")):
                continue
            base = Path(m.name).name
            seg_id = base[: -len(".token.npy")] if base.endswith(".token.npy") else base[: -len(".pose.npy")]
            kind = "token" if base.endswith(".token.npy") else "pose"
            arr = np.load(io.BytesIO(tf.extractfile(m).read()))
            if kind == "token" and max_frames:
                arr = arr[:max_frames]
            if kind == "pose" and max_frames:
                arr = arr[:max_frames]
            pending.setdefault(seg_id, {})[kind] = arr
            d = pending[seg_id]
            if "token" in d and "pose" in d:                  # complete pair → persist + count
                tp = out_dir / f"{seg_id}.token.npy"
                pp = out_dir / f"{seg_id}.pose.npy"
                np.save(tp, d["token"]); np.save(pp, d["pose"])
                done.append((str(tp), str(pp)))
                del pending[seg_id]
                print(f"[collect_real_drive] streamed real segment {len(done)}/{max_segments}: {seg_id}")
                if len(done) >= max_segments:
                    break                                     # early-abort: stop pulling the shard
    if not done:
        raise SystemExit("streamed shard yielded no complete (token,pose) pairs - check connectivity")
    return done


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("collect_real_drive")
    ap.add_argument("--commavq-dir", help="downloaded/extracted commaVQ directory (omit with --stream-hf)")
    ap.add_argument("--stream-hf", action="store_true",
                    help="stream a tiny real sample straight from HuggingFace (only a few MB pulled)")
    ap.add_argument("--shard", default="data-0000.tar.gz", help="HF shard to stream from")
    ap.add_argument("--out", default="ml/data/drive_real_pool")
    ap.add_argument("--max-segments", type=int, default=0, help="cap segments (0 = all found)")
    ap.add_argument("--max-frames-per-seg", type=int, default=0, help="cap frames/segment (0 = all)")
    args = ap.parse_args(argv)

    if args.stream_hf:
        n_seg = args.max_segments or 6
        raw_dir = Path(args.out).with_name(Path(args.out).name + "_raw")
        with_pose = stream_hf_sample(raw_dir, n_seg, shard=args.shard, max_frames=args.max_frames_per_seg)
    else:
        if not args.commavq_dir:
            raise SystemExit("pass --commavq-dir <dir> or --stream-hf")
        root = Path(args.commavq_dir)
        if not root.exists():
            raise SystemExit(f"commaVQ dir not found: {root} - download a shard first (see this file's header)")
        segs = discover_segments(root)
        with_pose = [s for s in segs if s[1]]
        if not with_pose:
            raise SystemExit(
                f"found {len(segs)} token file(s) but none with a matching pose in {root}. "
                "Real control needs comma's ego log - download a commaVQ shard that includes .pose.npy.")
        if args.max_segments:
            with_pose = with_pose[: args.max_segments]

    n = build_real_pool(with_pose, args.out, max_frames_per_seg=args.max_frames_per_seg)
    print(f"[collect_real_drive] built {n} REAL rollouts → {args.out}")
    return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
