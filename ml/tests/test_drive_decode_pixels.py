"""D2: the driving rollout server streams REAL decoded road pixels (not the token-id heatmap),
the imagined rollout stays ALIVE under sampling instead of freezing, and steering/telemetry
controllability is untouched by the RGB sampling.

Skips unless BOTH the served driving checkpoint and the 171MB commaVQ decoder are present
(gitignored single-copy assets).
"""

import base64
import io
from pathlib import Path

import numpy as np
import pytest
import torch

_ML = Path(__file__).resolve().parents[1]  # ml/ - resolve artifacts from here, not the CWD (pytest runs from ml/)
CKPT = _ML / "runs/drive/latest.pt"
WEIGHTS = _ML / "runs/drive/commavq_decoder.bin"

pytestmark = [
    pytest.mark.slow,  # CPU-heavy WM rollout + decode - excluded by verify-all fast mode (-m "not slow")
    pytest.mark.skipif(
        not (CKPT.is_file() and WEIGHTS.is_file()),
        reason="driving checkpoint or commaVQ decoder weights absent (gitignored)",
    ),
]


def _load(temperature=0.0, top_k=0):
    from blockdream_wm.drive.serve import load_drive_session
    return load_drive_session(str(CKPT), device="cpu", rgb_temperature=temperature, rgb_top_k=top_k)


def test_reset_returns_decoded_road_pixels():
    s = _load()
    assert s.decoder is not None                       # photoreal path active
    rgb = s.reset()["rgb"]
    assert rgb.shape == (3, 128, 256)                  # wide dashcam, NOT the 64x128 token field
    assert float(rgb.min()) >= 0.0 and float(rgb.max()) <= 1.0
    assert 0.05 < float(rgb.mean()) < 0.95 and float(rgb.std()) > 0.03


def test_served_frame_png_is_valid_image():
    from blockdream_wm.drive.serve import DriveServer
    srv = DriveServer(_load(temperature=0.8, top_k=100))
    reply = srv.handle({"type": "reset"})
    assert reply["type"] == "frame"
    img = _png(reply["rgb_png_b64"])
    assert img.size == (256, 128)                       # PIL (W, H)


def test_sampling_keeps_rollout_alive_vs_greedy_freeze():
    """Greedy decode converges to a frozen frame (copy-previous); sampling keeps it flowing."""
    torch.manual_seed(0)

    def change_rate(temperature, top_k):
        s = _load(temperature=temperature, top_k=top_k)
        s.reset()
        prev = s.tokens.clone()
        rates = []
        for _ in range(12):
            s.step([0.2, 1.0, 0.0])
            rates.append(float((s.tokens != prev).float().mean()))
            prev = s.tokens.clone()
        # ignore the first few warm-up steps; measure the steady state
        return float(np.mean(rates[5:]))

    greedy = change_rate(0.0, 0)
    sampled = change_rate(0.8, 100)
    assert greedy < 0.02            # greedy freezes (copy-previous fixed point)
    assert sampled > 0.10           # sampling keeps the imagined dashcam evolving
    assert sampled > greedy * 5


def test_sampling_does_not_corrupt_telemetry_controllability():
    """RGB sampling must not touch the telemetry/steering path (it comes from a deterministic head,
    not the sampled tokens). Same control sequence -> identical telemetry regardless of temperature."""
    torch.manual_seed(0)
    controls = [[0.5, 1.0, 0.0], [-0.5, 0.8, 0.0], [0.0, 0.0, 1.0], [0.9, 0.3, 0.0]]
    g = _load(temperature=0.0, top_k=0); g.reset()
    h = _load(temperature=0.9, top_k=100); h.reset()
    for c in controls:
        tg = g.step(c)["telemetry"]
        th = h.step(c)["telemetry"]
        assert torch.allclose(tg, th, atol=1e-5)       # telemetry identical despite different tokens


def test_fallback_token_field_without_decoder():
    """Honest degradation: with no decoder fetched the server still renders the token field."""
    s = _load()
    s.decoder = None                                   # simulate weights-absent
    rgb = s.reset()["rgb"]
    assert rgb.shape == (3, 64, 128)                   # the heatmap fallback, not a crash


# --- helpers ---------------------------------------------------------------
from PIL import Image  # noqa: E402


def _png(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64)))
