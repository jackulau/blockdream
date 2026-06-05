"""Live end-to-end: run the WS rollout server with the trained walking model,
drive it over a real socket with 'move right', and assert frames stream AND the
generated dot actually moves right (the model responds to input live)."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from mineworld_wm.serve import RolloutServer, load_demo_session
from mineworld_wm import train_demo

websockets = pytest.importorskip("websockets")

CKPT = Path(__file__).resolve().parents[1] / "checkpoints" / "walking.pt"


def ensure_checkpoint() -> Path:
    if not CKPT.exists():
        train_demo.main(["--demo", "walking", "--kind", "ar", "--steps", "250", "--tok-steps", "200", "--out", str(CKPT)])
    return CKPT


def centroid_x(png_b64: str) -> float:
    im = np.asarray(Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("L"), dtype=float)
    xs = np.arange(im.shape[1])
    col = im.sum(0)
    return float((col * xs).sum() / (col.sum() + 1e-6))


async def _drive():
    session = load_demo_session("walking", str(ensure_checkpoint()), kind="ar")
    server = RolloutServer(session)

    async def handler(ws):
        async for raw in ws:
            await ws.send(json.dumps(server.handle(json.loads(raw))))

    frames: list[str] = []
    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(json.dumps({"type": "reset"}))
            r = json.loads(await ws.recv())
            frames.append(r["png_b64"])
            for _ in range(8):  # hold "move right"
                await ws.send(json.dumps({"type": "action", "buttons": [0, 0, 0, 1, 0, 0, 0, 0, 0], "camera": [0.0, 0.0]}))
                r = json.loads(await ws.recv())
                frames.append(r["png_b64"])
    return frames


def test_live_drive_streams_and_responds_to_input():
    frames = asyncio.run(_drive())
    assert len(frames) >= 9  # reset + 8 steps streamed
    # frames must actually change over the rollout (streaming works)
    assert len(set(frames)) > 1, "all frames identical — no live generation"
    # 'move right' should push the generated dot rightward over the run
    xs = [centroid_x(f) for f in frames]
    assert xs[-1] > xs[0] + 0.5, f"dot did not move right under 'move right': {xs[0]:.1f} -> {xs[-1]:.1f}"
