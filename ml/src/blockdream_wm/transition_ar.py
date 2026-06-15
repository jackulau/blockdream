"""Autoregressive transition model (MineWorld-style).

Predicts the next frame's visual tokens from [action, prev-frame tokens], with the
next-frame tokens generated autoregressively (teacher-forced, causal mask). This
is the simplified single-step form: real MineWorld interleaves action+frame tokens
across a context window and uses Diagonal Decoding to lift the ~6fps interactive
ceiling - both are extensions of this core.
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
    def _generate_uncached(self, prev: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        """Reference greedy rollout - O(N^2), recomputes the whole sequence each step.
        Kept as the ground truth the KV-cached `generate` is tested against."""
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

    # --- KV-cached incremental decoding -------------------------------------------
    # Manual re-implementation of the norm_first TransformerEncoderLayer forward that
    # reuses the trained weights but caches per-layer K/V, so each new token attends a
    # single query over cached context instead of re-running the whole prefix
    # (O(N^2) -> O(N)). Output is token-identical to _generate_uncached (verified in
    # tests/test_kv_cache.py).

    def _heads(self):
        h = self.cfg.heads
        return h, self.cfg.dim // h

    def _qkv(self, layer, x):
        """x (B,T,dim) -> q,k,v each (B, H, T, hd) from the layer's in_proj weights."""
        attn = layer.self_attn
        qkv = F.linear(x, attn.in_proj_weight, attn.in_proj_bias)  # (B,T,3*dim)
        q, k, v = qkv.chunk(3, dim=-1)
        B, T, _ = q.shape
        H, hd = self._heads()
        shape = lambda t: t.view(B, T, H, hd).transpose(1, 2)  # noqa: E731  (B,H,T,hd)
        return shape(q), shape(k), shape(v)

    def _attn_out(self, layer, ctx):
        """ctx (B,H,T,hd) -> (B,T,dim) via out_proj."""
        B, H, T, hd = ctx.shape
        o = ctx.transpose(1, 2).reshape(B, T, H * hd)
        a = layer.self_attn
        return F.linear(o, a.out_proj.weight, a.out_proj.bias)

    def _ff(self, layer, x):
        return layer.linear2(F.gelu(layer.linear1(x)))

    @torch.no_grad()
    def generate(self, prev: torch.Tensor, action_emb: torch.Tensor) -> torch.Tensor:
        """Greedy autoregressive rollout of the next frame's tokens (B, n_tokens),
        KV-cached so each token is O(seq) instead of a full O(N) re-pass."""
        device = prev.device
        n = self.n_tokens
        _, hd = self._heads()
        scale = hd ** -0.5
        layers = list(self.transformer.layers)
        pos = torch.arange(n, device=device)
        seg = lambda i: self.seg_emb(torch.full((1,), i, dtype=torch.long, device=device))  # noqa: E731

        # static prefix: [action, prev tokens]  (B, 1+n, dim)
        a = self.action_proj(action_emb).unsqueeze(1) + seg(0)
        p = self.token_emb(prev) + self.pos_emb(pos) + seg(1)
        x = torch.cat([a, p], dim=1)
        P = x.shape[1]
        cmask = torch.triu(torch.ones(P, P, device=device, dtype=torch.bool), diagonal=1)

        caches = []  # per-layer [K, V]: (B, H, T, hd)
        for layer in layers:
            q, k, v = self._qkv(layer, layer.norm1(x))
            scores = (q @ k.transpose(-2, -1)) * scale
            scores = scores.masked_fill(cmask, float("-inf"))
            ctx = torch.softmax(scores, dim=-1) @ v
            x = x + self._attn_out(layer, ctx)
            x = x + self._ff(layer, layer.norm2(x))
            caches.append([k, v])

        out = [self.head(x[:, -1, :]).argmax(-1)]  # token 0 from the last prefix hidden

        for j in range(n - 1):  # tokens 1..n-1, feeding token j at position j
            xt = (self.token_emb(out[-1]).unsqueeze(1)
                  + self.pos_emb(pos[j:j + 1]) + seg(2))  # (B,1,dim)
            for li, layer in enumerate(layers):
                q, k, v = self._qkv(layer, layer.norm1(xt))
                K = torch.cat([caches[li][0], k], dim=2)
                V = torch.cat([caches[li][1], v], dim=2)
                caches[li][0], caches[li][1] = K, V
                ctx = torch.softmax((q @ K.transpose(-2, -1)) * scale, dim=-1) @ V  # attends all cached
                xt = xt + self._attn_out(layer, ctx)
                xt = xt + self._ff(layer, layer.norm2(xt))
            out.append(self.head(xt[:, -1, :]).argmax(-1))

        return torch.stack(out, dim=1)  # (B, n)
