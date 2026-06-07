"""Export the browser lineage to ONNX: the diffusion transition net + the VAE
decoder. The browser runs the few-step Euler loop in JS, calling transition.onnx
K times then decoder.onnx once (see ml/web/rollout.js).

    python -m mineworld_wm.export_onnx --config configs/toy.yaml --out onnx/
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn

from .config import Config, _merge, load_config
from .tokenizer import Tokenizer
from .transition_diffusion import LatentDiffusionTransition


class DecoderWrapper(nn.Module):
    """Wrap the tokenizer decoder as a standalone latent→image module for ONNX."""

    def __init__(self, tok: Tokenizer):
        super().__init__()
        self.tok = tok

    def forward(self, z: torch.Tensor) -> torch.Tensor:
        return self.tok.decode(z)


def export(config: str | None, out_dir: str, checkpoint: str | None = None) -> list[Path]:
    # A checkpoint gives REAL trained weights (the whole point — without one the browser engine would
    # run random noise). Its saved config defines the architecture; fall back to a config file otherwise.
    ckpt = None
    if checkpoint:
        ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
        cfg = _merge(Config(), ckpt["config"]) if "config" in ckpt else load_config(config)
    else:
        cfg = load_config(config)
    cfg.dynamics.kind = "diffusion"
    cfg.tokenizer.vq_codebook_size = 0  # continuous latents

    tok = Tokenizer(cfg.tokenizer).eval()
    trans = LatentDiffusionTransition(cfg.dynamics, latent_channels=cfg.tokenizer.latent_channels, action_dim=cfg.action.embed_dim).eval()
    if ckpt is not None:
        tok.load_state_dict(ckpt["tokenizer"])
        trans.load_state_dict(ckpt["transition"])
        print(f"[export_onnx] loaded trained weights from {checkpoint}")

    C = cfg.tokenizer.latent_channels
    h = cfg.latent_size
    z_t = torch.randn(1, C, h, h)
    t = torch.zeros(1)
    prev = torch.randn(1, C, h, h)
    action = torch.randn(1, cfg.action.embed_dim)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    trans_path = out / "transition.onnx"
    torch.onnx.export(
        trans,
        (z_t, t, prev, action),
        str(trans_path),
        input_names=["z_t", "t", "prev", "action"],
        output_names=["velocity"],
        opset_version=17,
        dynamic_axes={"z_t": {0: "batch"}, "t": {0: "batch"}, "prev": {0: "batch"}, "action": {0: "batch"}, "velocity": {0: "batch"}},
        dynamo=False,
    )
    written.append(trans_path)

    dec_path = out / "decoder.onnx"
    torch.onnx.export(
        DecoderWrapper(tok),
        (torch.randn(1, C, h, h),),
        str(dec_path),
        input_names=["latent"],
        output_names=["image"],
        opset_version=17,
        dynamic_axes={"latent": {0: "batch"}, "image": {0: "batch"}},
        dynamo=False,
    )
    written.append(dec_path)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("mineworld_wm.export_onnx")
    ap.add_argument("--config", type=str, default=None)
    ap.add_argument("--out", type=str, default="onnx")
    ap.add_argument("--checkpoint", type=str, default=None, help="trained diffusion checkpoint (real weights)")
    args = ap.parse_args(argv)
    written = export(args.config, args.out, args.checkpoint)
    for p in written:
        print(f"[export_onnx] wrote {p} ({p.stat().st_size} bytes)")
    print(f"[export_onnx] {len(written)} ONNX models exported → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
