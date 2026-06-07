"""Verify the exported browser diffusion engine actually works: load transition.onnx + decoder.onnx
with onnxruntime, run the SAME few-step Euler loop the browser (ml/web/rollout.js) runs, and assert
it produces a valid, non-degenerate frame at a real-time-capable rate. Exits 0 on success.

    ml/.venv/bin/python scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx --steps 8
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

try:
    import onnxruntime as ort
except Exception as e:  # pragma: no cover
    print(f"[verify-diffusion] onnxruntime not installed: {e}")
    sys.exit(2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("verify_diffusion_export")
    ap.add_argument("--onnx", default="../apps/web/public/onnx")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--min-fps", type=float, default=10.0)
    args = ap.parse_args(argv)

    d = Path(args.onnx)
    tp, dp = d / "transition.onnx", d / "decoder.onnx"
    if not tp.exists() or not dp.exists():
        print(f"[verify-diffusion] missing ONNX in {d} (need transition.onnx + decoder.onnx)")
        return 1

    transition = ort.InferenceSession(str(tp), providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(str(dp), providers=["CPUExecutionProvider"])

    # infer shapes from the transition's `prev` (1,C,H,H) and `action` (1,actionDim)
    shp = {i.name: i.shape for i in transition.get_inputs()}
    C, H = int(shp["prev"][1]), int(shp["prev"][2])
    action_dim = int(shp["action"][1])
    N = C * H * H
    print(f"[verify-diffusion] C={C} H={H} actionDim={action_dim} steps={args.steps}")

    rng = np.random.default_rng(0)
    prev = np.zeros((1, C, H, H), dtype=np.float32)
    action = rng.standard_normal((1, action_dim)).astype(np.float32)

    def sample_next() -> np.ndarray:
        z = rng.standard_normal((1, C, H, H)).astype(np.float32)
        dt = 1.0 / args.steps
        for i in range(args.steps):
            (vel,) = transition.run(
                ["velocity"],
                {"z_t": z, "t": np.array([i * dt], dtype=np.float32), "prev": prev, "action": action},
            )
            z = z + vel * dt
        return z

    # one warm frame, then time a few
    z = sample_next()
    (img,) = decoder.run(["image"], {"latent": z})
    img = np.asarray(img)

    # validity
    if img.shape[1] != 3:
        print(f"[verify-diffusion] FAIL: decoder output not 3-channel: {img.shape}")
        return 1
    if not np.isfinite(img).all():
        print("[verify-diffusion] FAIL: non-finite pixels")
        return 1
    spread = float(img.max() - img.min())
    if spread < 1e-3:
        print(f"[verify-diffusion] FAIL: degenerate (constant) frame, spread={spread:.5f}")
        return 1

    # fps over a few frames (transition loop + one decode each)
    n = 5
    t0 = time.time()
    for _ in range(n):
        decoder.run(["image"], {"latent": sample_next()})
    fps = n / (time.time() - t0)

    print(f"[verify-diffusion] frame {tuple(img.shape)} ok · pixel spread {spread:.3f} · {fps:.1f} gen-fps")
    ok = fps >= args.min_fps
    print(f"[verify-diffusion] verdict: {'PASS — exported engine runs few-step + decodes a real frame' if ok else f'SLOW (<{args.min_fps} fps)'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
