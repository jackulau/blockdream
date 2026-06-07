"""Typed configuration for the world-model stack.

Small dataclasses (no hydra dependency) loadable from YAML. The `toy` presets
are intentionally tiny so every test/CI step runs on CPU in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml


@dataclass
class TokenizerConfig:
    image_size: int = 64
    in_channels: int = 3
    latent_channels: int = 4
    base_channels: int = 32
    downsample: int = 4  # spatial reduction factor (image_size / latent grid)
    vq_codebook_size: int = 256  # 0 → continuous VAE (no quantization)
    vq_commit_beta: float = 0.25


@dataclass
class ActionConfig:
    # VPT-style action space
    n_buttons: int = 9            # discrete on/off controls (fwd/back/left/right/jump/sneak/sprint/attack/use)
    camera_bins: int = 11         # per-axis discrete camera bins (AR path)
    camera_continuous: bool = True  # browser/diffusion path uses continuous camera
    embed_dim: int = 64
    # Full control representation: condition on absolute look ORIENTATION (yaw, pitch, roll),
    # each normalized to [-1, 1]. Off by default for backward compatibility with existing
    # checkpoints (camera alone is a relative look-delta; orientation is the absolute pose,
    # which matters for boat steering / elytra glide / mounts where heading is part of dynamics).
    orientation: bool = False
    n_orientation: int = 3        # yaw, pitch, roll


@dataclass
class DynamicsConfig:
    kind: str = "ar"             # "ar" (autoregressive tokens) | "diffusion" (latent)
    dim: int = 128
    depth: int = 4
    heads: int = 4
    context_frames: int = 4
    diffusion_steps: int = 8     # few-step sampler for the browser path


@dataclass
class TrainConfig:
    lr: float = 3e-4
    batch_size: int = 4
    max_steps: int = 100
    seed: int = 0
    device: str = "cpu"


@dataclass
class DemoConfig:
    name: str = "walking"        # walking | boat | elytra | world | gameplay
    # subset of buttons active for this skill (indices into ActionConfig.n_buttons)
    active_buttons: list[int] = field(default_factory=lambda: list(range(9)))


@dataclass
class Config:
    tokenizer: TokenizerConfig = field(default_factory=TokenizerConfig)
    action: ActionConfig = field(default_factory=ActionConfig)
    dynamics: DynamicsConfig = field(default_factory=DynamicsConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    demo: DemoConfig = field(default_factory=DemoConfig)

    @property
    def latent_size(self) -> int:
        return self.tokenizer.image_size // self.tokenizer.downsample

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _merge(dc: Any, data: dict[str, Any]) -> Any:
    """Shallow-merge a dict of dicts into nested dataclasses."""
    for section, values in data.items():
        if hasattr(dc, section) and isinstance(values, dict):
            sub = getattr(dc, section)
            for k, v in values.items():
                if hasattr(sub, k):
                    setattr(sub, k, v)
    return dc


def load_config(path: str | Path | None = None) -> Config:
    cfg = Config()
    if path is None:
        return cfg
    data = yaml.safe_load(Path(path).read_text()) or {}
    return _merge(cfg, data)


def config_from_dict(data: dict[str, Any]) -> Config:
    """Rebuild a Config from a `cfg.to_dict()` mapping (e.g. a saved checkpoint)."""
    return _merge(Config(), data or {})
