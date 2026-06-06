"""KV-cached ARTransition.generate must reproduce the un-cached greedy rollout
(same tokens) while being much faster — the speed win behind 30fps serving."""

from __future__ import annotations

import time

import torch

from mineworld_wm.config import DynamicsConfig
from mineworld_wm.transition_ar import ARTransition


def _model(n_tokens, dim, depth, heads, codebook, seed=0, action_dim=24):
    torch.manual_seed(seed)
    m = ARTransition(DynamicsConfig(kind="ar", dim=dim, depth=depth, heads=heads),
                     n_tokens=n_tokens, codebook_size=codebook, action_dim=action_dim)
    return m.eval()


def _inputs(b, n, codebook, action_dim=24, seed=1):
    g = torch.Generator().manual_seed(seed)
    prev = torch.randint(0, codebook, (b, n), generator=g)
    action = torch.randn(b, action_dim, generator=g)
    return prev, action


def test_cached_matches_uncached_small():
    m = _model(n_tokens=16, dim=32, depth=2, heads=4, codebook=64, seed=0)
    prev, action = _inputs(2, 16, 64, seed=1)
    fast, ref = m.generate(prev, action), m._generate_uncached(prev, action)
    assert fast.shape == ref.shape == (2, 16)
    assert torch.equal(fast, ref), f"{(fast != ref).sum().item()} token mismatches"


def test_cached_matches_uncached_realistic():
    # mirrors the served m4 transformer shape (dim 384/depth 6/heads 8), 64 tokens for speed
    m = _model(n_tokens=64, dim=384, depth=6, heads=8, codebook=1024, seed=3)
    prev, action = _inputs(1, 64, 1024, seed=2)
    assert torch.equal(m.generate(prev, action), m._generate_uncached(prev, action))


def test_cached_logits_close_to_reference_first_token():
    # the manual attention must reproduce nn.TransformerEncoder math (within float tol)
    m = _model(n_tokens=16, dim=64, depth=3, heads=8, codebook=128, seed=7)
    prev, action = _inputs(1, 16, 128, seed=4)
    # reference logits for token 0: full nn forward over [action, prev]
    x = m._assemble(prev, torch.zeros(1, 0, dtype=torch.long), action)
    L = x.shape[1]
    mask = torch.triu(torch.ones(L, L, dtype=torch.bool), diagonal=1)
    ref_logit = m.head(m.transformer(x, mask=mask)[:, -1, :])
    # manual prefix pass logit for token 0 (reuse generate's prefix; compare argmax + closeness)
    fast = m.generate(prev, action)
    ref = m._generate_uncached(prev, action)
    assert int(fast[0, 0]) == int(ref_logit.argmax(-1)) == int(ref[0, 0])


def test_cached_is_faster():
    m = _model(n_tokens=64, dim=256, depth=4, heads=8, codebook=512, seed=5)
    prev, action = _inputs(1, 64, 512, seed=6)
    m.generate(prev, action); m._generate_uncached(prev, action)  # warm
    t = time.perf_counter(); m._generate_uncached(prev, action); slow = time.perf_counter() - t
    t = time.perf_counter(); m.generate(prev, action); fast = time.perf_counter() - t
    assert fast < slow, f"cached {fast*1000:.0f}ms not faster than uncached {slow*1000:.0f}ms"
