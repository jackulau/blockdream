"""Device selection — Apple Silicon (MPS) > CUDA > CPU."""

from __future__ import annotations

import os

import torch


def pick_device(pref: str = "auto") -> torch.device:
    if pref and pref != "auto":
        return torch.device(pref)
    if torch.backends.mps.is_available():
        # let unsupported ops fall back to CPU instead of erroring
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def device_name(d: torch.device) -> str:
    if d.type == "mps":
        return "Apple Silicon GPU (MPS)"
    if d.type == "cuda":
        return f"CUDA ({torch.cuda.get_device_name(0)})"
    return "CPU"
