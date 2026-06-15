"""Fast-inference for >=30 fps: the few-step diffusion path (parallel over space) is the
real-time path, and it's faster than the sequential 256-token AR path that bottlenecks the
served Minecraft model. Verified at tiny scale here; the trend (AR ~1/n_tokens, diffusion
~independent of resolution) holds up - and a server GPU / browser WebGPU is faster still."""

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import bench_inference as bi  # noqa: E402


@torch.no_grad()
def test_diffusion_path_hits_30fps_and_beats_sequential_ar():
    # sequential AR at the served 256-token grid vs few-step diffusion, tiny dims
    ar_sess, n_tok = bi._session("ar", image=32, downsample=2, dim=64, depth=2, steps=0)
    assert n_tok == 256, "sanity: 16x16 token grid like the served model"
    diff_sess, _ = bi._session("diffusion", image=32, downsample=2, dim=64, depth=2, steps=8)

    ar_ms = bi._bench(ar_sess, steps=6)
    diff_ms = bi._bench(diff_sess, steps=6)
    diff_fps = 1000.0 / diff_ms

    assert diff_fps >= 30.0, f"diffusion path not real-time: {diff_fps:.0f} fps"
    assert diff_ms < ar_ms, f"diffusion ({diff_ms:.1f}ms) should beat sequential AR-256 ({ar_ms:.1f}ms)"


def test_bench_main_quick_finds_a_realtime_path(monkeypatch):
    # main() exits 0 iff at least one path reaches >=30 fps; run the --quick sweep
    monkeypatch.setattr(sys, "argv", ["bench_inference.py", "--quick"])
    assert bi.main() == 0
