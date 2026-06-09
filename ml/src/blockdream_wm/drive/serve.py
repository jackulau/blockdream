"""Multimodal driving rollout server: load a trained checkpoint, hold the recursive
state (RGB tokens + LiDAR + telemetry), step under (steer, throttle, brake), and
stream {RGB PNG, LiDAR vector, telemetry} to the browser tester."""

from __future__ import annotations

import math

import torch

from ..config import TokenizerConfig, DynamicsConfig
from ..tokenizer import Tokenizer
from ..serve import frame_to_png_b64
from ..device import pick_device
from .transition import DriveTransition


class DriveSession:
    def __init__(self, ckpt: dict, device: str = "auto"):
        self.device = pick_device(device)
        self.tok = Tokenizer(TokenizerConfig(**ckpt["tokenizer_cfg"]))
        self.tok.load_state_dict(ckpt["tokenizer"])
        n_tokens = (ckpt["image"] // ckpt["downsample"]) ** 2
        self.trans = DriveTransition(DynamicsConfig(**ckpt["dynamics_cfg"]), n_tokens=n_tokens,
                                     codebook_size=ckpt["codebook"], n_lidar=ckpt["n_lidar"], n_telemetry=ckpt["n_telemetry"])
        self.trans.load_state_dict(ckpt["transition"])
        self.tok = self.tok.to(self.device).eval()
        self.trans = self.trans.to(self.device).eval()
        self.grid = ckpt["image"] // ckpt["downsample"]
        self._init = (ckpt["init_tokens"], ckpt["init_lidar"], ckpt["init_telemetry"])
        self.step_idx = 0
        self.reset()

    @torch.no_grad()
    def reset(self):
        t, l, te = self._init
        self.tokens = t.view(1, -1).clone().to(self.device)
        self.lidar = l.view(1, -1).clone().to(self.device)
        self.tel = te.view(1, -1).clone().to(self.device)
        self.step_idx = 0
        return self._decode()

    @torch.no_grad()
    def _decode(self):
        rgb = self.tok.decode_tokens(self.tokens.view(1, self.grid, self.grid))[0]
        return {"rgb": rgb.cpu(), "lidar": self.lidar[0].cpu(), "telemetry": self.tel[0].cpu()}

    @torch.no_grad()
    def step(self, control):
        c = torch.tensor([control], dtype=torch.float32, device=self.device)
        self.tokens, self.lidar, self.tel = self.trans.step(self.tokens, self.lidar, self.tel, c)
        self.step_idx += 1
        return self._decode()

    def fork(self) -> "DriveSession":
        """Independent recursive state (tokens/LiDAR/telemetry) over the SAME model
        weights — one per WebSocket connection. Skips __init__ so the checkpoint is
        not re-loaded; reset() clones the shared init tensors into fresh state."""
        s = object.__new__(DriveSession)
        s.device, s.tok, s.trans, s.grid, s._init = self.device, self.tok, self.trans, self.grid, self._init
        s.step_idx = 0
        s.reset()
        return s


def _finite4(x: float) -> float:
    """Round to 4 dp, mapping NaN/Inf → 0.0 so the JSON we emit is always valid + plottable
    (json.dumps would otherwise serialise NaN/Infinity, which the browser's JSON.parse rejects)."""
    x = float(x)
    return round(x, 4) if math.isfinite(x) else 0.0


class DriveServer:
    def __init__(self, session: DriveSession):
        self.session = session

    def fork(self) -> "DriveServer":
        """A server over an independent session (shared weights) — one per connection."""
        return DriveServer(self.session.fork())

    def handle(self, msg: dict) -> dict:
        t = msg.get("type")
        if t == "reset":
            o = self.session.reset()
        elif t == "action":
            ctrl = msg.get("control", [0.0, 0.0, 0.0])
            o = self.session.step([float(ctrl[0]), float(ctrl[1]), float(ctrl[2])])
        else:
            return {"type": "error", "message": f"unknown type {t!r}"}
        return {
            "type": "frame",
            "step": self.session.step_idx,
            "rgb_png_b64": frame_to_png_b64(o["rgb"]),
            "lidar": [_finite4(x) for x in o["lidar"].tolist()],
            "telemetry": [_finite4(x) for x in o["telemetry"].tolist()],
        }


def load_drive_session(path: str, device: str = "auto") -> DriveSession:
    return DriveSession(torch.load(path, map_location="cpu", weights_only=False), device=device)


def ws_handler(server: DriveServer):
    """Per-connection WebSocket handler factory (same hardening as ..serve.ws_handler):
    each connection drives its OWN forked session so concurrent clients cannot corrupt
    each other's recursive state, and malformed messages get an {"error": ...} reply
    instead of tearing the connection down."""
    import json

    async def handler(ws):
        conn = server.fork()  # per-connection rollout state (weights shared)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict):
                        raise TypeError(f"expected a JSON object, got {type(msg).__name__}")
                    reply = conn.handle(msg)
                except Exception as e:  # bad message: report it, keep the socket alive
                    reply = {"type": "error", "error": f"{type(e).__name__}: {e}".splitlines()[0]}
                await ws.send(json.dumps(reply))
        finally:
            conn.session.tokens = conn.session.lidar = conn.session.tel = None  # free state

    return handler


async def run_ws(server: DriveServer, host: str = "127.0.0.1", port: int = 8766):  # pragma: no cover
    import asyncio
    import websockets

    print(f"[drive.serve] driving world model on ws://{host}:{port}")
    async with websockets.serve(ws_handler(server), host, port):
        await asyncio.Future()


def main(argv: list[str] | None = None) -> int:  # pragma: no cover
    import argparse
    import asyncio

    ap = argparse.ArgumentParser("blockdream_wm.drive.serve")
    ap.add_argument("--checkpoint", default="ml/checkpoints/drive.pt")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--device", default="cpu")  # CPU is faster for sequential AR decode (see serve.py)
    args = ap.parse_args(argv)
    server = DriveServer(load_drive_session(args.checkpoint, device=args.device))
    try:
        asyncio.run(run_ws(server, args.host, args.port))
    except KeyboardInterrupt:
        print("\n[drive.serve] stopped")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
