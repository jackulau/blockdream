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


class DriveServer:
    def __init__(self, session: DriveSession):
        self.session = session

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
            "lidar": [round(float(x), 4) for x in o["lidar"].tolist()],
            "telemetry": [round(float(x), 4) for x in o["telemetry"].tolist()],
        }


def load_drive_session(path: str, device: str = "auto") -> DriveSession:
    return DriveSession(torch.load(path, map_location="cpu", weights_only=False), device=device)


async def run_ws(server: DriveServer, host: str = "127.0.0.1", port: int = 8766):  # pragma: no cover
    import asyncio
    import json
    import websockets

    async def handler(ws):
        async for raw in ws:
            await ws.send(json.dumps(server.handle(json.loads(raw))))

    print(f"[drive.serve] driving world model on ws://{host}:{port}")
    async with websockets.serve(handler, host, port):
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
