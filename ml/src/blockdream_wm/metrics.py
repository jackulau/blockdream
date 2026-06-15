"""Eval metrics: reconstruction, action-conditioning, and an FVD stub.

The FVD stub is a Fréchet-style distance over flattened pixel features - a real
pipeline swaps in I3D/VideoMAE features. It is labeled a stub so it is never
mistaken for true FVD.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F


@torch.no_grad()
def reconstruction_mse(tokenizer, frames: torch.Tensor) -> float:
    return F.mse_loss(tokenizer(frames).recon, frames).item()


@torch.no_grad()
def ar_action_accuracy(ar, prev_tokens, next_tokens, action_emb) -> float:
    """Teacher-forced next-token accuracy - how well the AR model predicts."""
    pred = ar(prev_tokens, next_tokens, action_emb).argmax(-1)
    return (pred == next_tokens).float().mean().item()


@torch.no_grad()
def action_conditioning_score(transition, prev, next_latent, action_emb, steps: int = 8) -> float:
    """
    Does the action actually condition the prediction? Sample with the true
    action vs a row-shuffled (wrong) action; return mse_wrong / mse_true. A value
    > 1 means the model genuinely uses the action (higher = more action-sensitive).
    """
    true = transition.sample(prev, action_emb, steps=steps)
    perm = torch.roll(action_emb, shifts=1, dims=0)
    wrong = transition.sample(prev, perm, steps=steps)
    mse_true = F.mse_loss(true, next_latent).item()
    mse_wrong = F.mse_loss(wrong, next_latent).item()
    return mse_wrong / max(mse_true, 1e-8)


@torch.no_grad()
def fvd_stub(real: torch.Tensor, fake: torch.Tensor) -> float:
    """Fréchet-style distance over flattened features (STUB - not true FVD)."""
    r = real.reshape(real.shape[0], -1)
    f = fake.reshape(fake.shape[0], -1)
    mu_r, mu_f = r.mean(0), f.mean(0)
    sig_r, sig_f = r.std(0), f.std(0)
    return (((mu_r - mu_f) ** 2).sum() + ((sig_r - sig_f) ** 2).sum()).sqrt().item()
