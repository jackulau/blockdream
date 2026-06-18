"""comma.ai commaVQ VQ-VAE DECODER - turns the driving world model's predicted
commaVQ tokens into real road pixels.

The driving world model predicts comma's VQ tokens (codebook 1024, 128 tokens =
an 8x16 grid per frame). Those tokens are an opaque compressed code; to see the
actual dashcam image they must be run through comma's VQ-VAE decoder. This module
vendors that decoder so the rollout server can stream REAL footage instead of a
token-id heatmap.

Decoder I/O:  encoding_indices (B, 128) int64, values in [0, 1024)
          ->  image (B, 3, 128, 256) float (wide forward dashcam view)

The 171MB weights (`decoder_pytorch_model.bin`) are MIT-licensed and fetched on
demand from `commaai/commavq-gpt2m` into gitignored `ml/runs/drive/` by
`scripts/fetch-commavq-decoder.sh` - never redistributed in-repo.

Attribution
-----------
Architecture vendored from comma.ai commaVQ (https://github.com/commaai/commavq,
MIT), which itself adapts CompVis/taming-transformers (https://github.com/CompVis/
taming-transformers, MIT). The einops `rearrange` calls in the upstream are rewritten
with plain torch reshape/permute here so the module has no einops dependency; the
module/parameter layout is byte-for-byte compatible with comma's published
`decoder_pytorch_model.bin` (loaded strict=True).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

# default location of the fetched weights (gitignored single-copy asset)
DEFAULT_DECODER_WEIGHTS = "ml/runs/drive/commavq_decoder.bin"
COMMAVQ_DECODER_URL = (
    "https://huggingface.co/commaai/commavq-gpt2m/resolve/main/decoder_pytorch_model.bin"
)


@dataclass
class CompressorConfig:
    in_channels: int = 3
    out_channels: int = 3
    ch_mult: tuple[int, ...] = (1, 1, 2, 2, 4)
    attn_resolutions: tuple[int, ...] = (16,)
    resolution: int = 256
    num_res_blocks: int = 2
    z_channels: int = 256
    vocab_size: int = 1024
    ch: int = 128
    dropout: float = 0.0

    @property
    def num_resolutions(self) -> int:
        return len(self.ch_mult)

    @property
    def quantized_resolution(self) -> int:
        return self.resolution // 2 ** (self.num_resolutions - 1)


def nonlinearity(x: torch.Tensor) -> torch.Tensor:  # swish
    return x * torch.sigmoid(x)


def Normalize(in_channels: int) -> nn.GroupNorm:
    return nn.GroupNorm(num_groups=32, num_channels=in_channels, eps=1e-6, affine=True)


class Upsample(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.conv = nn.Conv2d(in_channels, in_channels, kernel_size=3, stride=1, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.interpolate(x, scale_factor=2.0, mode="nearest")
        return self.conv(x)


class ResnetBlock(nn.Module):
    def __init__(self, *, in_channels: int, out_channels: int | None = None,
                 conv_shortcut: bool = False, dropout: float, temb_channels: int = 512):
        super().__init__()
        self.in_channels = in_channels
        out_channels = in_channels if out_channels is None else out_channels
        self.out_channels = out_channels
        self.use_conv_shortcut = conv_shortcut

        self.norm1 = Normalize(in_channels)
        self.conv1 = nn.Conv2d(in_channels, out_channels, kernel_size=3, stride=1, padding=1)
        if temb_channels > 0:
            self.temb_proj = nn.Linear(temb_channels, out_channels)
        self.norm2 = Normalize(out_channels)
        self.dropout = nn.Dropout(dropout)
        self.conv2 = nn.Conv2d(out_channels, out_channels, kernel_size=3, stride=1, padding=1)
        if self.in_channels != self.out_channels:
            if self.use_conv_shortcut:
                self.conv_shortcut = nn.Conv2d(in_channels, out_channels, kernel_size=3, stride=1, padding=1)
            else:
                self.nin_shortcut = nn.Conv2d(in_channels, out_channels, kernel_size=1, stride=1, padding=0)

    def forward(self, x: torch.Tensor, temb: torch.Tensor | None) -> torch.Tensor:
        h = x
        h = self.norm1(h)
        h = nonlinearity(h)
        h = self.conv1(h)
        if temb is not None:
            h = h + self.temb_proj(nonlinearity(temb))[:, :, None, None]
        h = self.norm2(h)
        h = nonlinearity(h)
        h = self.dropout(h)
        h = self.conv2(h)
        if self.in_channels != self.out_channels:
            x = self.conv_shortcut(x) if self.use_conv_shortcut else self.nin_shortcut(x)
        return x + h


class AttnBlock(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.in_channels = in_channels
        self.norm = Normalize(in_channels)
        self.q = nn.Conv2d(in_channels, in_channels, kernel_size=1, stride=1, padding=0)
        self.k = nn.Conv2d(in_channels, in_channels, kernel_size=1, stride=1, padding=0)
        self.v = nn.Conv2d(in_channels, in_channels, kernel_size=1, stride=1, padding=0)
        self.proj_out = nn.Conv2d(in_channels, in_channels, kernel_size=1, stride=1, padding=0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h_ = self.norm(x)
        q, k, v = self.q(h_), self.k(h_), self.v(h_)
        b, c, h, w = q.shape
        q = q.reshape(b, c, h * w).permute(0, 2, 1)   # b,hw,c
        k = k.reshape(b, c, h * w)                     # b,c,hw
        w_ = torch.bmm(q, k) * (int(c) ** (-0.5))      # b,hw,hw
        w_ = F.softmax(w_, dim=2)
        v = v.reshape(b, c, h * w)
        w_ = w_.permute(0, 2, 1)
        h_ = torch.bmm(v, w_).reshape(b, c, h, w)
        return x + self.proj_out(h_)


class VectorQuantizer(nn.Module):
    """Codebook lookup. Only the decode/embed half is exercised here (tokens -> latents);
    the encode path is kept for state_dict-key parity with comma's published weights."""

    def __init__(self, num_embeddings: int, embedding_dim: int):
        super().__init__()
        self._embedding_dim = embedding_dim
        self._num_embeddings = num_embeddings
        self._embedding = nn.Embedding(num_embeddings, embedding_dim)
        self._embedding.weight.data.uniform_(-1 / num_embeddings, 1 / num_embeddings)

    def embed(self, encoding_indices: torch.Tensor) -> torch.Tensor:
        # encoding_indices: (N, 1) long -> one-hot (N, num_embeddings) -> (N, embedding_dim)
        encodings = torch.zeros(encoding_indices.shape[0], self._num_embeddings,
                                device=encoding_indices.device, dtype=self._embedding.weight.dtype)
        encodings.scatter_(1, encoding_indices, 1)
        return torch.matmul(encodings, self._embedding.weight)

    def decode(self, encoding_indices: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        b, s = encoding_indices.shape
        flat = encoding_indices.reshape(b * s, 1).long()        # '(b s) 1'
        quantized = self.embed(flat)                            # (b*s, c)
        quantized = quantized.reshape(b, s, self._embedding_dim).contiguous()  # 'b s c'
        return quantized, flat.reshape(b, s)


class Decoder(nn.Module):
    """commaVQ VQ-VAE decoder: token indices (B, 128) -> image (B, 3, 128, 256)."""

    def __init__(self, config: CompressorConfig):
        super().__init__()
        self.temb_ch = 0
        self.config = config

        block_in = config.ch * config.ch_mult[config.num_resolutions - 1]
        curr_res = config.quantized_resolution

        self.post_quant_conv = nn.Conv2d(config.z_channels, config.z_channels, 1)
        self.quantize = VectorQuantizer(config.vocab_size, config.z_channels)
        self.conv_in = nn.Conv2d(config.z_channels, block_in, kernel_size=3, stride=1, padding=1)

        self.mid = nn.Module()
        self.mid.block_1 = ResnetBlock(in_channels=block_in, out_channels=block_in,
                                       temb_channels=self.temb_ch, dropout=config.dropout)
        self.mid.attn_1 = AttnBlock(block_in)
        self.mid.block_2 = ResnetBlock(in_channels=block_in, out_channels=block_in,
                                       temb_channels=self.temb_ch, dropout=config.dropout)

        self.up = nn.ModuleList()
        for i_level in reversed(range(config.num_resolutions)):
            block = nn.ModuleList()
            attn = nn.ModuleList()
            block_out = config.ch * config.ch_mult[i_level]
            for _ in range(config.num_res_blocks + 1):
                block.append(ResnetBlock(in_channels=block_in, out_channels=block_out,
                                         temb_channels=self.temb_ch, dropout=config.dropout))
                block_in = block_out
                if curr_res in config.attn_resolutions:
                    attn.append(AttnBlock(block_in))
            up = nn.Module()
            up.block = block
            up.attn = attn
            if i_level != 0:
                up.upsample = Upsample(block_in)
                curr_res = curr_res * 2
            self.up.insert(0, up)  # prepend to get consistent order

        self.norm_out = Normalize(block_in)
        self.conv_out = nn.Conv2d(block_in, config.out_channels, kernel_size=3, stride=1, padding=1)

    def forward(self, encoding_indices: torch.Tensor) -> torch.Tensor:
        z, _ = self.quantize.decode(encoding_indices)           # (b, s, c)
        b, s, c = z.shape
        w = self.config.quantized_resolution
        h = s // w
        z = z.reshape(b, h, w, c).permute(0, 3, 1, 2).contiguous()  # 'b (h w) c -> b c h w'
        z = self.post_quant_conv(z)

        temb = None
        hh = self.conv_in(z)
        hh = self.mid.block_1(hh, temb)
        hh = self.mid.attn_1(hh)
        hh = self.mid.block_2(hh, temb)

        for i_level in reversed(range(self.config.num_resolutions)):
            for i_block in range(self.config.num_res_blocks + 1):
                hh = self.up[i_level].block[i_block](hh, temb)
                if len(self.up[i_level].attn) > 0:
                    hh = self.up[i_level].attn[i_block](hh)
            if i_level != 0:
                hh = self.up[i_level].upsample(hh)

        hh = self.norm_out(hh)
        hh = nonlinearity(hh)
        hh = self.conv_out(hh)
        return ((hh + 1.0) / 2.0) * 255.0                       # [~0, 255]


def decoder_weights_path(path: str | None = None) -> Path:
    return Path(path or DEFAULT_DECODER_WEIGHTS)


def has_decoder(path: str | None = None) -> bool:
    """True when the fetched 171MB weights are present (the photoreal path is available)."""
    return decoder_weights_path(path).is_file()


def load_decoder(path: str | None = None, device: str = "cpu") -> Decoder:
    """Build the decoder and load comma's published weights (strict - any key drift raises)."""
    p = decoder_weights_path(path)
    if not p.is_file():
        raise FileNotFoundError(
            f"commaVQ decoder weights not found at {p}. Fetch them with "
            f"`bash scripts/fetch-commavq-decoder.sh` (171MB, MIT, from commaai/commavq-gpt2m)."
        )
    dec = Decoder(CompressorConfig())
    state = torch.load(p, map_location="cpu", weights_only=True)
    dec.load_state_dict(state, strict=True)
    return dec.eval().to(device)


@torch.no_grad()
def decode_tokens_chw01(decoder: Decoder, tokens: torch.Tensor) -> torch.Tensor:
    """tokens (128,) or (1,128) or (8,16) int -> image (3, 128, 256) float in [0, 1].

    Drop-in for the rollout server's `_decode`: returns the same (3, H, W) [0,1] shape the
    token-field heatmap produced, so the browser draws real road pixels with no frontend change."""
    t = tokens.reshape(1, -1).long()
    if t.shape[1] != 128:
        raise ValueError(f"commaVQ decoder expects 128 tokens/frame, got {t.shape[1]}")
    img = decoder(t)[0]                       # (3, 128, 256) in [~0,255]
    return (img / 255.0).clamp(0.0, 1.0)
