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
        # REAL commaVQ path: pre-tokenized real dashcam (no RGB tokenizer to load), camera-only
        # (n_lidar=0), rendered as a token field (photoreal decode needs comma's VQ decoder).
        self.real_source = ckpt.get("real_source")
        self.n_history = int(ckpt.get("n_history", 0))  # legacy checkpoints carry no key → 0
        if self.real_source == "commavq":
            self.tok = None
            n_tokens = int(ckpt["n_tokens"])
            self.token_grid = tuple(ckpt.get("token_grid", [8, 16]))
            self.grid = self.token_grid  # (h, w) of the token field
            self.trans = DriveTransition(DynamicsConfig(**ckpt["dynamics_cfg"]), n_tokens=n_tokens,
                                         codebook_size=ckpt["codebook"], n_lidar=ckpt["n_lidar"],
                                         n_telemetry=ckpt["n_telemetry"], n_history=self.n_history)
            self.codebook = int(ckpt["codebook"])
        else:
            self.tok = Tokenizer(TokenizerConfig(**ckpt["tokenizer_cfg"]))
            self.tok.load_state_dict(ckpt["tokenizer"])
            n_tokens = (ckpt["image"] // ckpt["downsample"]) ** 2
            self.trans = DriveTransition(DynamicsConfig(**ckpt["dynamics_cfg"]), n_tokens=n_tokens,
                                         codebook_size=ckpt["codebook"], n_lidar=ckpt["n_lidar"],
                                         n_telemetry=ckpt["n_telemetry"], n_history=self.n_history)
            self.tok = self.tok.to(self.device).eval()
            self.grid = ckpt["image"] // ckpt["downsample"]
        self.trans.load_state_dict(ckpt["transition"])
        self.trans = self.trans.to(self.device).eval()
        self._init = (ckpt["init_tokens"], ckpt["init_lidar"], ckpt["init_telemetry"])
        self.step_idx = 0
        self.reset()

    @torch.no_grad()
    def reset(self):
        t, l, te = self._init
        self.tokens = t.view(1, -1).clone().to(self.device)
        self.lidar = l.view(1, -1).clone().to(self.device)
        self.tel = self._physical_tel(te.view(1, -1).clone().to(self.device))
        # temporal-context window of the last n_history (control, telemetry) rows - zeros at
        # reset (the model trains with zero-init windows, so this matches the data distribution)
        self.hist_rows = [
            torch.zeros((1, self.trans.n_control + self.trans.n_telemetry), device=self.device)
            for _ in range(self.n_history)
        ]
        self.step_idx = 0
        return self._decode()

    @torch.no_grad()
    def _decode(self):
        if self.real_source == "commavq":
            rgb = self._token_field_rgb()
        else:
            rgb = self.tok.decode_tokens(self.tokens.view(1, self.grid, self.grid))[0]
        return {"rgb": rgb.cpu(), "lidar": self.lidar[0].cpu(), "telemetry": self.tel[0].cpu()}

    @torch.no_grad()
    def _token_field_rgb(self, out_h: int = 64, out_w: int = 128):
        """Render the REAL model's predicted commaVQ token field as an image. Photoreal pixels need
        comma's VQ decoder (not bundled - operator-gated); this shows the real, control-responsive
        token dynamics directly (the field shifts as the world model rolls under control)."""
        import torch.nn.functional as F
        h, w = self.token_grid
        t = self.tokens.view(h, w).float() / max(1, self.codebook)  # (h,w) in [0,1]
        # 3-channel colormap so structure is legible (not flat gray): a smooth R/G/B ramp of the code id
        rgb = torch.stack([t, (t * 1.7 % 1.0), (1.0 - t)], dim=0).unsqueeze(0)  # (1,3,h,w)
        rgb = F.interpolate(rgb, size=(out_h, out_w), mode="nearest")[0]
        return rgb.clamp(0, 1)

    @torch.no_grad()
    def step(self, control):
        c = torch.tensor([control], dtype=torch.float32, device=self.device)
        h = torch.cat(self.hist_rows, dim=-1) if self.n_history > 0 else None
        if self.n_history > 0:  # row_t = (control applied at t, telemetry observed at t) - pre-step
            self.hist_rows = self.hist_rows[1:] + [torch.cat([c, self.tel], dim=-1)]
        self.tokens, self.lidar, self.tel = self.trans.step(self.tokens, self.lidar, self.tel, c, history=h)
        self.tel = self._physical_tel(self.tel)
        self.step_idx += 1
        return self._decode()

    def _physical_tel(self, tel):
        """REAL commaVQ is forward dashcam video - the car never reverses, so the forward-speed
        telemetry channels ([0]=vx/30, [3]=speed/30) are physically NON-NEGATIVE. The shared telemetry
        bound uses a symmetric tanh (right for the sim's signed channels) which can dip a hair below 0
        at a standstill; floor the speed channels at 0 for the camera-only real model so the recursively
        fed-back state stays physical. Yaw/lat/sin/cos stay signed. No-op for the sim model."""
        if self.real_source == "commavq":
            tel = tel.clone()
            tel[:, 0].clamp_(min=0.0)
            tel[:, 3].clamp_(min=0.0)
        return tel

    def fork(self) -> "DriveSession":
        """Independent recursive state (tokens/LiDAR/telemetry) over the SAME model
        weights - one per WebSocket connection. Skips __init__ so the checkpoint is
        not re-loaded; reset() clones the shared init tensors into fresh state."""
        s = object.__new__(DriveSession)
        s.device, s.tok, s.trans, s.grid, s._init = self.device, self.tok, self.trans, self.grid, self._init
        s.n_history = self.n_history
        s.real_source = self.real_source
        if self.real_source == "commavq":
            s.token_grid, s.codebook = self.token_grid, self.codebook
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
        """A server over an independent session (shared weights) - one per connection."""
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
