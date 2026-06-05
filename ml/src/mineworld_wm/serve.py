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
        # default seed frame for reset() (set by load_demo_session to a centered agent)
        self.default_init: torch.Tensor | None = None

    @torch.no_grad()
    def reset(self, init_frame: torch.Tensor | None = None) -> StepResult:
        if init_frame is None:
            init_frame = self.default_init if self.default_init is not None else torch.zeros(3, self.size, self.size)
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
    import asyncio
    import json

    try:
        import websockets
    except ImportError as e:  # pragma: no cover
        raise SystemExit("run_ws needs the 'websockets' package: pip install websockets") from e

    async def handler(ws):
        async for raw in ws:
            await ws.send(json.dumps(server.handle(json.loads(raw))))

    print(f"[serve] mineworld world-model on ws://{host}:{port}  (demo={server.session.cfg.demo.name})")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()


def load_demo_session(demo: str, checkpoint: str | None = None, seed: int = 0, kind: str | None = None) -> WorldModelSession:
    """Build a demo session and optionally load a trained checkpoint into it."""
    from .demos import build_demo_session  # lazy: demos imports serve

    session, _ = build_demo_session(demo, seed=seed, kind=kind)
    if checkpoint:
        ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
        session.tok.load_state_dict(ckpt["tokenizer"])
        session.enc.load_state_dict(ckpt["action"])
        session.trans.load_state_dict(ckpt["transition"])
    # seed reset() from a centered-agent frame so the interactive rollout starts valid
    from .data import demo_init_frame

    session.default_init = demo_init_frame(session.size)
    return session


def load_real_checkpoint(path: str) -> WorldModelSession:
    """Load a checkpoint trained on real data (train_real.py) into a session."""
    from .config import config_from_dict
    from .tokenizer import Tokenizer
    from .actions import ActionEncoder
    from .transition_ar import ARTransition

    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    cfg = config_from_dict(ckpt["config"])
    tok = Tokenizer(cfg.tokenizer)
    enc = ActionEncoder(cfg.action)
    n = cfg.latent_size**2
    trans = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)
    tok.load_state_dict(ckpt["tokenizer"])
    enc.load_state_dict(ckpt["action"])
    trans.load_state_dict(ckpt["transition"])
    session = WorldModelSession(cfg, tok, enc, trans)
    if ckpt.get("init_frame") is not None:
        session.default_init = ckpt["init_frame"]
    return session


def main(argv: list[str] | None = None) -> int:  # pragma: no cover
    import argparse
    import asyncio

    ap = argparse.ArgumentParser("mineworld_wm.serve")
    ap.add_argument("--demo", default="walking")
    ap.add_argument("--checkpoint", default=None)
    ap.add_argument("--real", default=None, help="path to a train_real.py checkpoint (real VPT model)")
    ap.add_argument("--kind", default="ar", choices=["ar", "diffusion"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args(argv)

    if args.real:
        session = load_real_checkpoint(args.real)
    else:
        session = load_demo_session(args.demo, args.checkpoint, kind=args.kind)
    server = RolloutServer(session)
    try:
        asyncio.run(run_ws(server, args.host, args.port))
    except KeyboardInterrupt:
        print("\n[serve] stopped")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
