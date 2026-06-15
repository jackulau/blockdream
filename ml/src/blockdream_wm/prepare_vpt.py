"""Fetch real OpenAI VPT Minecraft demos and prepare an aligned (frames, actions)
dataset for training. Streams only a short window per segment via ffmpeg (the full
mp4s are ~170 MB) and downloads the per-frame action .jsonl.

    python -m blockdream_wm.prepare_vpt --segments 1 --seconds 8 --size 64 --fps 10 --out ml/data/vpt_sample
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import numpy as np

from .vpt_actions import parse_vpt_action

INDEX_URL = "https://openaipublic.blob.core.windows.net/minecraft-rl/snapshots/all_10xx_Jun_29.json"
VPT_FPS = 20  # VPT video + jsonl are 20 Hz


def fetch_index(url: str = INDEX_URL) -> dict:
    with urllib.request.urlopen(url, timeout=60) as r:
        raw = r.read().decode("utf-8-sig")
    return json.loads(raw)


def fetch_jsonl(url: str) -> list[dict]:
    with urllib.request.urlopen(url, timeout=120) as r:
        text = r.read().decode("utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def stream_frames(mp4_url: str, seconds: float, fps: int, size: int) -> np.ndarray:
    """Download the mp4 (these are non-fragmented - moov atom at end, so the whole
    file is needed) then extract the first `seconds` → (T, size, size, 3) uint8."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=True) as tmp:
        with urllib.request.urlopen(mp4_url, timeout=300) as r:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                tmp.write(chunk)
        tmp.flush()
        args = [
            "ffmpeg", "-v", "error",
            "-t", str(seconds), "-i", tmp.name,
            "-vf", f"fps={fps},scale={size}:{size}:flags=area",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]
        proc = subprocess.run(args, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', 'ignore')[:400]}")
    frame_bytes = size * size * 3
    n = len(proc.stdout) // frame_bytes
    if n == 0:
        raise RuntimeError("ffmpeg produced no frames")
    return np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8).reshape(n, size, size, 3)


def prepare(segments: int, seconds: float, fps: int, size: int, out: str, index_url: str = INDEX_URL) -> tuple[int, int]:
    idx = fetch_index(index_url)
    base = idx["basedir"]
    relpaths = idx["relpaths"]
    step = max(1, VPT_FPS // fps)  # jsonl-line stride to match the sampled fps

    all_frames: list[np.ndarray] = []
    all_actions: list[np.ndarray] = []
    for rel in relpaths[:segments]:
        mp4_url = base + rel
        jsonl_url = base + rel[: -len(".mp4")] + ".jsonl"
        frames = stream_frames(mp4_url, seconds, fps, size)
        actions_raw = fetch_jsonl(jsonl_url)
        # align: sampled frame i ↔ jsonl line i*step
        acts = []
        for i in range(frames.shape[0]):
            j = min(i * step, len(actions_raw) - 1)
            btn, cam = parse_vpt_action(actions_raw[j])
            acts.append(btn + cam)  # 9 + 2 = 11
        all_frames.append(frames)
        all_actions.append(np.asarray(acts, dtype=np.float32))
        print(f"[prepare_vpt] {rel.split('/')[-1]}: {frames.shape[0]} frames @ {size}px")

    frames_arr = np.concatenate(all_frames, axis=0)
    actions_arr = np.concatenate(all_actions, axis=0)
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "frames.npy", frames_arr)
    np.save(out_dir / "actions.npy", actions_arr)
    print(f"[prepare_vpt] wrote {frames_arr.shape[0]} frames + actions → {out_dir}")
    return frames_arr.shape[0], actions_arr.shape[0]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.prepare_vpt")
    ap.add_argument("--segments", type=int, default=1)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--size", type=int, default=64)
    ap.add_argument("--out", default="ml/data/vpt_sample")
    ap.add_argument("--index-url", default=INDEX_URL)
    args = ap.parse_args(argv)
    nf, na = prepare(args.segments, args.seconds, args.fps, args.size, args.out, args.index_url)
    return 0 if nf == na and nf > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
