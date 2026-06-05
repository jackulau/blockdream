"""Autoregressive transition model (MineWorld-style).

Predicts the next frame's visual tokens from [action, prev-frame tokens], with the
next-frame tokens generated autoregressively (teacher-forced, causal mask). This
is the simplified single-step form: real MineWorld interleaves action+frame tokens
across a context window and uses Diagonal Decoding to lift the ~6fps interactive
ceiling — both are extensions of this core.
"""

from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F

from .config import DynamicsConfig


class ARTransition(nn.Module):
    def __init__(self, cfg: DynamicsConfig, n_tokens: int, codebook_size: int, action_dim: int):
        super().__init__()
        self.cfg = cfg
        self.n_tokens = n_tokens          # tokens per frame (h*w)
        self.codebook_size = codebook_size
        self.token_emb = nn.Embedding(codebook_size, cfg.dim)
        self.pos_emb = nn.Embedding(n_tokens, cfg.dim)
        self.seg_emb = nn.Embedding(3, cfg.dim)   # 0=action, 1=prev, 2=next
        self.action_proj = nn.Linear(action_dim, cfg.dim)
        layer = nn.TransformerEncoderLayer(
            d_model=cfg.dim, nhead=cfg.heads, dim_feedforward=cfg.dim * 4,
            batch_first=True, norm_first=True, activation="gelu",
        )
        self.transformer = nn.TransformerEncoder(layer, num_layers=cfg.depth, enable_nested_tensor=False)
        self.head = nn.Linear(cfg.dim, codebook_size)

    def _assemble(self, prev: torch.Tensor, next_in: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        b = prev.shape[0]
        device = prev.device
        n = self.n_tokens
        pos = torch.arange(n, device=device)

        a = self.action_proj(action_emb).unsqueeze(1) + self.seg_emb(torch.zeros(1, dtype=torch.long, device=device))
        p = self.token_emb(prev) + self.pos_emb(pos) + self.seg_emb(torch.ones(1, dtype=torch.long, device=device))
        if next_in.shape[1] > 0:
            ni = (
                self.token_emb(next_in)
                + self.pos_emb(pos[: next_in.shape[1]])
                + self.seg_emb(torch.full((1,), 2, dtype=torch.long, device=device))
            )
            x = torch.cat([a, p, ni], dim=1)
        else:
            x = torch.cat([a, p], dim=1)
        return x  # (B, 1 + n + (n-1), dim) when teacher forcing full next

    def forward(self, prev: torch.Tensor, next_tokens: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        """prev, next_tokens: (B, n_tokens) int; action_emb: (B, action_dim).
        Returns logits (B, n_tokens, codebook) predicting next_tokens."""
        next_in = next_tokens[:, :-1]
        x = self._assemble(prev, next_in, action_emb)
        L = x.shape[1]
        mask = torch.triu(torch.ones(L, L, device=x.device, dtype=torch.bool), diagonal=1)
        h = self.transformer(x, mask=mask)
        logits = self.head(h[:, self.n_tokens :, :])  # last n_tokens positions
        return logits

    def loss(self, prev: torch.Tensor, next_tokens: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        logits = self.forward(prev, next_tokens, action_emb)
        return F.cross_entropy(logits.reshape(-1, self.codebook_size), next_tokens.reshape(-1))

    @torch.no_grad()
    def generate(self, prev: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        """Greedy autoregressive rollout of the next frame's tokens (B, n_tokens)."""
        b = prev.shape[0]
        device = prev.device
        out = torch.zeros(b, 0, dtype=torch.long, device=device)
        for _ in range(self.n_tokens):
            x = self._assemble(prev, out, action_emb)
            L = x.shape[1]
            mask = torch.triu(torch.ones(L, L, device=device, dtype=torch.bool), diagonal=1)
            h = self.transformer(x, mask=mask)
            logit = self.head(h[:, -1, :])
            nxt = logit.argmax(-1, keepdim=True)
            out = torch.cat([out, nxt], dim=1)
        return out
