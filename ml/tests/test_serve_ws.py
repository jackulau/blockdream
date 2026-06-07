"""Real-WebSocket round-trip against the rollout server."""

from __future__ import annotations

import asyncio
import json

import pytest

from blockdream_wm.serve import RolloutServer
from blockdream_wm.demos import build_demo_session

websockets = pytest.importorskip("websockets")


async def _roundtrip():
    session, _ = build_demo_session("walking", seed=0)
    server = RolloutServer(session)

    async def handler(ws):
        async for raw in ws:
            await ws.send(json.dumps(server.handle(json.loads(raw))))

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(json.dumps({"type": "reset"}))
            r1 = json.loads(await ws.recv())
            await ws.send(json.dumps({"type": "action", "buttons": [1, 0, 0, 0, 0, 0, 0, 0, 0], "camera": [0.0, 0.0]}))
            r2 = json.loads(await ws.recv())
            return r1, r2


def test_ws_reset_action_frame_roundtrip():
    r1, r2 = asyncio.run(_roundtrip())
    assert r1["type"] == "frame" and r1["step"] == 0
    assert r2["type"] == "frame" and r2["step"] == 1
    assert r2["shape"] == [3, 32, 32]
    assert isinstance(r2["png_b64"], str) and len(r2["png_b64"]) > 100
