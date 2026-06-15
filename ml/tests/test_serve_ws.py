"""Real-WebSocket round-trips against the rollout + drive servers.

Uses the production `ws_handler` factories, so these tests cover the actual
per-connection forking and malformed-message hardening that run_ws serves.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from blockdream_wm.serve import RolloutServer, ws_handler
from blockdream_wm.demos import build_demo_session

websockets = pytest.importorskip("websockets")

WALK = {"type": "action", "buttons": [1, 0, 0, 0, 0, 0, 0, 0, 0], "camera": [0.0, 0.0]}
TURN = {"type": "action", "buttons": [0, 0, 1, 0, 0, 0, 0, 0, 0], "camera": [-0.4, 0.2]}


def _server(kind: str | None = None) -> RolloutServer:
    session, _ = build_demo_session("walking", seed=0, kind=kind)
    return RolloutServer(session)


async def _rpc(ws, msg: dict | str) -> dict:
    await ws.send(msg if isinstance(msg, str) else json.dumps(msg))
    return json.loads(await ws.recv())


async def _roundtrip():
    async with websockets.serve(ws_handler(_server()), "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            r1 = await _rpc(ws, {"type": "reset"})
            r2 = await _rpc(ws, WALK)
            return r1, r2


def test_ws_reset_action_frame_roundtrip():
    r1, r2 = asyncio.run(_roundtrip())
    assert r1["type"] == "frame" and r1["step"] == 0
    assert r2["type"] == "frame" and r2["step"] == 1
    assert r2["shape"] == [3, 32, 32]
    assert isinstance(r2["png_b64"], str) and len(r2["png_b64"]) > 100


async def _two_clients_interleaved():
    # AR kind: greedy decode is fully deterministic, so identical frames prove state
    # isolation (the diffusion kind draws fresh sampling noise from the global RNG).
    async with websockets.serve(ws_handler(_server(kind="ar")), "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"
        async with websockets.connect(url) as a, websockets.connect(url) as b:
            await _rpc(a, {"type": "reset"})
            await _rpc(b, {"type": "reset"})
            a_frames, a_steps, b_steps = [], [], []
            for _ in range(3):  # strictly interleave A and B traffic at the server
                ra = await _rpc(a, WALK)
                rb = await _rpc(b, TURN)
                a_frames.append(ra["png_b64"])
                a_steps.append(ra["step"])
                b_steps.append(rb["step"])
        # solo baseline: a fresh connection replaying A's exact sequence, no B traffic
        async with websockets.connect(url) as c:
            await _rpc(c, {"type": "reset"})
            solo_frames = [(await _rpc(c, WALK))["png_b64"] for _ in range(3)]
    return a_frames, a_steps, b_steps, solo_frames


def test_ws_concurrent_clients_are_independent():
    a_frames, a_steps, b_steps, solo_frames = asyncio.run(_two_clients_interleaved())
    # each connection has its own step counter (a shared session would interleave them)
    assert a_steps == [1, 2, 3]
    assert b_steps == [1, 2, 3]
    # the deterministic (greedy) rollout is identical with or without B's interleaved
    # traffic - B's resets/steps do not perturb A's state
    assert a_frames == solo_frames


async def _malformed_then_valid():
    async with websockets.serve(ws_handler(_server()), "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            bad_json = await _rpc(ws, "{not json")
            not_object = await _rpc(ws, json.dumps([1, 2, 3]))
            bad_field = await _rpc(ws, {"type": "action", "buttons": "junk"})
            ok = await _rpc(ws, {"type": "reset"})
            return bad_json, not_object, bad_field, ok


def test_ws_malformed_message_replies_error_and_survives():
    bad_json, not_object, bad_field, ok = asyncio.run(_malformed_then_valid())
    for r in (bad_json, not_object, bad_field):
        assert r["type"] == "error"
        assert isinstance(r["error"], str) and r["error"] and "\n" not in r["error"]
    assert ok["type"] == "frame" and ok["step"] == 0  # connection still alive + usable


# --- drive server (blockdream_wm.drive.serve) -----------------------------------


async def _drive_clients():
    from blockdream_wm.drive.serve import DriveServer, DriveSession
    from blockdream_wm.drive.serve import ws_handler as drive_ws_handler
    from test_drive_serve import _tiny_checkpoint

    server = DriveServer(DriveSession(_tiny_checkpoint()))
    async with websockets.serve(drive_ws_handler(server), "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"
        async with websockets.connect(url) as a, websockets.connect(url) as b:
            # malformed messages: error reply, connection stays alive
            bad_json = await _rpc(a, "{not json")
            bad_field = await _rpc(a, {"type": "action", "control": [0.0]})  # too short
            # per-connection state: A steps twice; B's reset must not zero A's counter
            await _rpc(a, {"type": "reset"})
            ra1 = await _rpc(a, {"type": "action", "control": [0.5, 0.4, 0.0]})
            rb0 = await _rpc(b, {"type": "reset"})
            ra2 = await _rpc(a, {"type": "action", "control": [0.5, 0.4, 0.0]})
            return bad_json, bad_field, ra1, rb0, ra2


def test_drive_ws_malformed_and_independent_sessions():
    bad_json, bad_field, ra1, rb0, ra2 = asyncio.run(_drive_clients())
    for r in (bad_json, bad_field):
        assert r["type"] == "error"
        assert isinstance(r["error"], str) and r["error"] and "\n" not in r["error"]
    assert ra1["type"] == "frame" and ra1["step"] == 1
    assert rb0["type"] == "frame" and rb0["step"] == 0
    assert ra2["step"] == 2  # B's reset did not touch A's session
