"""Interactive rollout server: S_t + A_t → S_{t+1}, streamed to a web client.

The protocol is JSON messages so it is trivially testable in-process (no socket
needed); `run_ws()` exposes the same handler over a real WebSocket when the
optional `websockets` package is installed.

Rollout cache: the current state (prev tokens / latent) is kept on the session and
reused as the context for the next step — so stepping the world never re-tokenizes
the previous frame. Per-token KV-caching inside AR generation (MineWorld's
Diagonal Decoding) is a further speedup that needs a custom attention; noted.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass

import torch

from .config import Config
from .tokenizer import Tokenizer
from .actions import ActionEncoder
from .transition_ar import ARTransition
from .transition_diffusion import LatentDiffusionTransition


def frame_to_png_b64(img: torch.Tensor) -> str:
    """img: (3, H, W) in [0, 1] → base64 PNG."""
    from PIL import Image

    arr = (img.clamp(0, 1) * 255).round().byte().permute(1, 2, 0).cpu().numpy()
    buf = io.BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@dataclass
class StepResult:
    step: int
    frame: torch.Tensor  # (3, H, W)


class WorldModelSession:
    """Stateful single-stream rollout engine."""

    def __init__(self, cfg: Config, tok: Tokenizer, enc: ActionEncoder, trans):
        self.cfg = cfg
        self.tok = tok
        self.enc = enc
        self.trans = trans
        self.kind = cfg.dynamics.kind
        self.size = cfg.tokenizer.image_size
        self.step_idx = 0
        # cached state (the rollout cache): prev tokens (AR) or prev latent (diffusion)
        self._prev: torch.Tensor | None = None

    @torch.no_grad()
    def reset(self, init_frame: torch.Tensor | None = None) -> StepResult:
        if init_frame is None:
            init_frame = torch.zeros(3, self.size, self.size)
        x = init_frame.unsqueeze(0)
        if self.kind == "ar":
            self._prev = self.tok.tokenize(x).flatten(1)  # (1, N)
        else:
            self._prev = self.tok.encode(x)  # (1, C, h, w)
        self.step_idx = 0
        return StepResult(0, init_frame)

    @torch.no_grad()
    def step(self, buttons: torch.Tensor, camera: torch.Tensor) -> StepResult:
        if self._prev is None:
            self.reset()
        action = self.enc(buttons.view(1, -1), camera.view(1, 2))
        if self.kind == "ar":
            nxt = self.trans.generate(self._prev, action)  # (1, N)
            grid = int(nxt.shape[1] ** 0.5)
            frame = self.tok.decode_tokens(nxt.view(1, grid, grid))[0]
            self._prev = nxt
        else:
            nxt = self.trans.sample(self._prev, action)  # (1, C, h, w)
            frame = self.tok.decode(nxt)[0]
            self._prev = nxt
        self.step_idx += 1
        return StepResult(self.step_idx, frame)


class RolloutServer:
    """JSON message handler — same logic over in-process calls or a WebSocket."""

    def __init__(self, session: WorldModelSession):
        self.session = session

    def handle(self, msg: dict) -> dict:
        t = msg.get("type")
        if t == "reset":
            r = self.session.reset()
        elif t == "action":
            buttons = torch.tensor(msg.get("buttons", [0] * self.session.cfg.action.n_buttons), dtype=torch.float32)
            camera = torch.tensor(msg.get("camera", [0.0, 0.0]), dtype=torch.float32)
            r = self.session.step(buttons, camera)
        else:
            return {"type": "error", "message": f"unknown message type {t!r}"}
        return {
            "type": "frame",
            "step": r.step,
            "shape": list(r.frame.shape),
            "png_b64": frame_to_png_b64(r.frame),
        }


async def run_ws(server: RolloutServer, host: str = "127.0.0.1", port: int = 8765) -> None:  # pragma: no cover
    """Serve over a real WebSocket (requires `pip install websockets`)."""
    import json

    try:
        import websockets
    except ImportError as e:  # pragma: no cover
        raise SystemExit("run_ws needs the 'websockets' package: pip install websockets") from e

    async def handler(ws):
        async for raw in ws:
            await ws.send(json.dumps(server.handle(json.loads(raw))))

    async with websockets.serve(handler, host, port):
        import asyncio

        await asyncio.Future()
