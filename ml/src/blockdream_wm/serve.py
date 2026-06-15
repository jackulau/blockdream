"""Interactive rollout server: S_t + A_t → S_{t+1}, streamed to a web client.

The protocol is JSON messages so it is trivially testable in-process (no socket
needed); `run_ws()` exposes the same handler over a real WebSocket when the
optional `websockets` package is installed.

Rollout cache: the current state (prev tokens / latent) is kept on the session and
reused as the context for the next step - so stepping the world never re-tokenizes
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
from .logutil import get_logger, timed

LOG = get_logger("serve")


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

    def __init__(self, cfg: Config, tok: Tokenizer, enc: ActionEncoder, trans, device: str | torch.device = "cpu"):
        self.cfg = cfg
        self.device = torch.device(device)
        self.tok = tok.to(self.device)
        self.enc = enc.to(self.device)
        self.trans = trans.to(self.device)
        self.kind = cfg.dynamics.kind
        self.size = cfg.tokenizer.image_size
        self.step_idx = 0
        # cached state (the rollout cache): prev tokens (AR) or prev latent (diffusion)
        self._prev: torch.Tensor | None = None
        # default seed frame for reset() (set by load_demo_session to a centered agent)
        self.default_init: torch.Tensor | None = None
        # current movement type (skill id) for a skill-conditioned model
        self.skill: int = 0

    @torch.no_grad()
    def reset(self, init_frame: torch.Tensor | None = None) -> StepResult:
        if init_frame is None:
            init_frame = self.default_init if self.default_init is not None else torch.zeros(3, self.size, self.size)
        x = init_frame.unsqueeze(0).to(self.device)
        if self.kind == "ar":
            self._prev = self.tok.tokenize(x).flatten(1)  # (1, N)
        else:
            self._prev = self.tok.encode(x)  # (1, C, h, w)
        self.step_idx = 0
        return StepResult(0, init_frame)

    @torch.no_grad()
    def step(self, buttons: torch.Tensor, camera: torch.Tensor, orientation: torch.Tensor | None = None) -> StepResult:
        if self._prev is None:
            self.reset()
        if hasattr(self.enc, "default_skill"):
            self.enc.default_skill = self.skill  # condition on the selected movement type
        bt = buttons.view(1, -1).to(self.device)
        cam = camera.view(1, 2).to(self.device)
        # only pass orientation when present, so encoders without an orientation channel
        # (e.g. DemoEncoder) keep working unchanged.
        if orientation is not None:
            action = self.enc(bt, cam, orientation=orientation.view(1, -1).to(self.device))
        else:
            action = self.enc(bt, cam)
        with timed(LOG, f"step[{self.kind}]"):  # per-step latency at DEBUG (off the hot path otherwise)
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

    def fork(self) -> "WorldModelSession":
        """Independent rollout state over the SAME model weights.

        Used to give each WebSocket connection its own session: `.to()` on a module is
        in-place, so the constructor shares tok/enc/trans rather than copying them -
        only the rollout cache (`_prev`), step counter and skill are per-fork.
        """
        s = WorldModelSession(self.cfg, self.tok, self.enc, self.trans, device=self.device)
        s.default_init = self.default_init
        s.skill = self.skill
        return s


class RolloutServer:
    """JSON message handler - same logic over in-process calls or a WebSocket."""

    def __init__(self, session: WorldModelSession):
        self.session = session

    def fork(self) -> "RolloutServer":
        """A server over an independent rollout session (shared weights) - one per connection."""
        return RolloutServer(self.session.fork())

    def _set_skill(self, msg: dict) -> None:
        if "skill" in msg and msg["skill"] is not None:
            from .movement import skill_id
            s = msg["skill"]
            self.session.skill = skill_id(s) if isinstance(s, str) else int(s)

    def handle(self, msg: dict) -> dict:
        t = msg.get("type")
        self._set_skill(msg)  # any message may carry a "skill" (movement type)
        if t == "skill":
            from .movement import MOVEMENT_TYPES
            return {"type": "ok", "skill": MOVEMENT_TYPES[self.session.skill]}
        if t == "reset":
            r = self.session.reset()
        elif t == "action":
            buttons = torch.tensor(msg.get("buttons", [0] * self.session.cfg.action.n_buttons), dtype=torch.float32)
            camera = torch.tensor(msg.get("camera", [0.0, 0.0]), dtype=torch.float32)
            ori_list = msg.get("orientation")  # optional [yaw, pitch, roll] in [-1, 1]
            orientation = torch.tensor(ori_list, dtype=torch.float32) if ori_list is not None else None
            r = self.session.step(buttons, camera, orientation)
        else:
            return {"type": "error", "message": f"unknown message type {t!r}"}
        return {
            "type": "frame",
            "step": r.step,
            "shape": list(r.frame.shape),
            "png_b64": frame_to_png_b64(r.frame),
        }


def ws_handler(server: RolloutServer):
    """Per-connection WebSocket handler factory.

    Each connection gets its OWN forked session (the browser demo and the Fabric mod
    both default to ws://127.0.0.1:8765; interleaving reset/skill/step against one
    shared rollout cache corrupts both streams). Model weights stay shared; only the
    rollout state is per-connection, created on connect and dropped on disconnect.

    Malformed messages (bad JSON, wrong field types) get an {"error": ...} reply and
    the connection stays alive instead of the exception tearing the handler down.
    """
    import json

    async def handler(ws):
        conn = server.fork()  # per-connection rollout state (weights shared)
        LOG.debug("client connected: forked session")
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
            conn.session._prev = None  # free this connection's rollout cache
            LOG.debug("client disconnected: session freed")

    return handler


async def run_ws(server: RolloutServer, host: str = "127.0.0.1", port: int = 8765) -> None:  # pragma: no cover
    """Serve over a real WebSocket (requires `pip install websockets`)."""
    import asyncio

    try:
        import websockets
    except ImportError as e:  # pragma: no cover
        raise SystemExit("run_ws needs the 'websockets' package: pip install websockets") from e

    LOG.info("world-model serving on ws://%s:%d (demo=%s)", host, port, server.session.cfg.demo.name)
    async with websockets.serve(ws_handler(server), host, port):
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


def load_real_checkpoint(path: str, device: str = "auto") -> WorldModelSession:
    """Load a checkpoint trained on real data (train_real.py / train_long.py)."""
    from .config import config_from_dict
    from .tokenizer import Tokenizer
    from .actions import ActionEncoder
    from .transition_ar import ARTransition
    from .device import pick_device, device_name

    dev = pick_device(device)
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    cfg = config_from_dict(ckpt["config"])
    tok = Tokenizer(cfg.tokenizer)
    if ckpt.get("skill_conditioned"):
        from .movement import SkillRealEncoder, N_MOVEMENT
        enc = SkillRealEncoder(cfg.action, ckpt.get("n_skills", N_MOVEMENT))
    else:
        enc = ActionEncoder(cfg.action)
    n = cfg.latent_size**2
    trans = ARTransition(cfg.dynamics, n_tokens=n, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim)
    tok.load_state_dict(ckpt["tokenizer"])
    enc.load_state_dict(ckpt["action"])
    trans.load_state_dict(ckpt["transition"])
    session = WorldModelSession(cfg, tok, enc, trans, device=dev)
    if ckpt.get("init_frame") is not None:
        session.default_init = ckpt["init_frame"]
    LOG.info("world model on %s (%d tokens/frame, KV-cached)", device_name(dev), n)
    return session


def main(argv: list[str] | None = None) -> int:  # pragma: no cover
    import argparse
    import asyncio

    ap = argparse.ArgumentParser("blockdream_wm.serve")
    ap.add_argument("--demo", default="walking")
    ap.add_argument("--checkpoint", default=None)
    ap.add_argument("--real", default=None, help="path to a train_real.py checkpoint (real VPT model)")
    ap.add_argument("--kind", default="ar", choices=["ar", "diffusion"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    # CPU beats MPS for this sequential token-by-token decode - 256 tiny per-step kernel
    # launches make GPU dispatch overhead dominate (measured 450ms CPU vs 1066ms MPS/frame).
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args(argv)

    if args.real:
        session = load_real_checkpoint(args.real, device=args.device)
    else:
        session = load_demo_session(args.demo, args.checkpoint, kind=args.kind)
    server = RolloutServer(session)
    try:
        asyncio.run(run_ws(server, args.host, args.port))
    except KeyboardInterrupt:
        LOG.info("stopped")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
