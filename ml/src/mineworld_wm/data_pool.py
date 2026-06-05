"""Resumable VPT data pool: download many segments to a per-segment cache (skips
already-fetched ones), then load the pool with valid within-segment consecutive
pairs for training.

    python -m mineworld_wm.data_pool --segments 80 --seconds 30 --size 128 --fps 10 --out ml/data/pool128
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .prepare_vpt import fetch_index, fetch_jsonl, stream_frames, INDEX_URL, VPT_FPS
from .vpt_actions import parse_vpt_action


def prepare_pool(segments: int, seconds: float, fps: int, size: int, out: str, index_url: str = INDEX_URL) -> int:
    """Download/extract `segments` VPT clips into out/seg_*.npz, skipping cached ones."""
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    idx = fetch_index(index_url)
    base, relpaths = idx["basedir"], idx["relpaths"]
    step = max(1, VPT_FPS // fps)
    manifest = out_dir / "manifest.json"
    done = set(json.loads(manifest.read_text())) if manifest.exists() else set()

    for i, rel in enumerate(relpaths[:segments]):
        seg = out_dir / f"seg_{i:05d}.npz"
        if seg.exists():
            done.add(rel)
            continue
        frames = stream_frames(base + rel, seconds, fps, size)
        actions_raw = fetch_jsonl(base + rel[: -len(".mp4")] + ".jsonl")
        acts = np.zeros((frames.shape[0], 11), dtype=np.float32)
        for j in range(frames.shape[0]):
            btn, cam = parse_vpt_action(actions_raw[min(j * step, len(actions_raw) - 1)])
            acts[j] = btn + cam  # 9 buttons + 2 camera
        np.savez_compressed(seg, frames=frames, actions=acts)
        done.add(rel)
        manifest.write_text(json.dumps(sorted(done)))
        print(f"[pool] {i + 1}/{segments} {rel.split('/')[-1]}: {frames.shape[0]} frames @ {size}px (cached)")

    n_cached = len(list(out_dir.glob("seg_*.npz")))
    print(f"[pool] {n_cached} segments cached in {out_dir}")
    return n_cached


def load_pool(out: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """→ (frames uint8 (N,H,W,3), actions float32 (N,11), pairs int (P,2) within-segment)."""
    out_dir = Path(out)
    segs = sorted(out_dir.glob("seg_*.npz"))
    if not segs:
        raise FileNotFoundError(f"no segments in {out_dir} — run prepare_pool first")
    frames_list, actions_list, pairs = [], [], []
    offset = 0
    for s in segs:
        d = np.load(s)
        f, a = d["frames"], d["actions"]
        L = f.shape[0]
        frames_list.append(f)
        actions_list.append(a)
        for t in range(L - 1):  # consecutive pairs only WITHIN this segment
            pairs.append((offset + t, offset + t + 1))
        offset += L
    return np.concatenate(frames_list), np.concatenate(actions_list), np.asarray(pairs, dtype=np.int64)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.data_pool")
    ap.add_argument("--segments", type=int, default=80)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--size", type=int, default=128)
    ap.add_argument("--out", default="ml/data/pool128")
    args = ap.parse_args(argv)
    n = prepare_pool(args.segments, args.seconds, args.fps, args.size, args.out)
    return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
