"""D1 proof: comma's vendored VQ decoder turns REAL commaVQ tokens into a real road
image - NOT the token-id heatmap ramp.

Skips when the 171MB weights aren't fetched (gitignored single-copy asset). When present,
this is the ground truth that the driving demo can render actual footage.
"""

from pathlib import Path

import numpy as np
import pytest
import torch

from blockdream_wm.drive import commavq_decoder as D

_ML = Path(__file__).resolve().parents[1]  # ml/ - resolve artifacts from here, not the CWD (pytest runs from ml/)
WEIGHTS = _ML / "runs/drive/commavq_decoder.bin"
FIXTURES = _ML / "tests/fixtures/commavq_real"

pytestmark = [
    pytest.mark.slow,  # CPU-heavy decoder inference - excluded by verify-all fast mode (-m "not slow")
    pytest.mark.skipif(
        not WEIGHTS.is_file(),
        reason="commaVQ decoder weights absent - run scripts/fetch-commavq-decoder.sh (171MB)",
    ),
]


def _real_token_frames(n: int = 6) -> np.ndarray:
    """First n frames of a REAL commaVQ token shard, shape (n, 128) int64 in [0,1024)."""
    shards = sorted(FIXTURES.glob("*.token.npy"))
    assert shards, f"no real commaVQ token fixtures in {FIXTURES}"
    tok = np.load(shards[0])                       # (T, 8, 16) int16
    tok = tok.reshape(tok.shape[0], -1).astype(np.int64)
    return tok[:n]


def test_decoder_loads_strict():
    """Vendored architecture matches comma's published state_dict byte-for-byte (strict load)."""
    dec = D.load_decoder(str(WEIGHTS), device="cpu")
    assert isinstance(dec, D.Decoder)


def test_decodes_real_frame_to_road_image():
    dec = D.load_decoder(str(WEIGHTS), device="cpu")
    frames = _real_token_frames()
    tok0 = torch.from_numpy(frames[0])
    assert int(tok0.max()) < 1024 and int(tok0.min()) >= 0  # valid codebook indices

    img = D.decode_tokens_chw01(dec, tok0)
    # shape = wide forward dashcam view
    assert img.shape == (3, 128, 256)
    # real pixels: in-range, not all-black / all-white, has spatial structure
    assert float(img.min()) >= 0.0 and float(img.max()) <= 1.0
    assert 0.05 < float(img.mean()) < 0.95
    assert float(img.std()) > 0.03

    # NOT the token-field heatmap: that ramp sets R=t, B=1-t  ->  R+B == 1 everywhere.
    # A real decode does not satisfy that invariant.
    r_plus_b = (img[0] + img[2])
    assert float((r_plus_b - 1.0).abs().mean()) > 0.05


def test_distinct_frames_decode_differently():
    dec = D.load_decoder(str(WEIGHTS), device="cpu")
    frames = _real_token_frames()
    a = D.decode_tokens_chw01(dec, torch.from_numpy(frames[0]))
    b = D.decode_tokens_chw01(dec, torch.from_numpy(frames[5]))
    assert float((a - b).abs().mean()) > 0.01     # different driving moments -> different images


def test_decode_is_deterministic():
    dec = D.load_decoder(str(WEIGHTS), device="cpu")
    tok = torch.from_numpy(_real_token_frames(1)[0])
    a = D.decode_tokens_chw01(dec, tok)
    b = D.decode_tokens_chw01(dec, tok)
    assert torch.allclose(a, b)


def test_rejects_wrong_token_count():
    dec = D.load_decoder(str(WEIGHTS), device="cpu")
    with pytest.raises(ValueError):
        D.decode_tokens_chw01(dec, torch.zeros(64, dtype=torch.long))  # not 128
