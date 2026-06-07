import torch

from blockdream_wm.config import TokenizerConfig, ActionConfig, DynamicsConfig
from blockdream_wm.tokenizer import Tokenizer
from blockdream_wm.actions import ActionEncoder
from blockdream_wm.data import make_rollouts
from blockdream_wm.transition_ar import ARTransition


def _setup():
    torch.manual_seed(0)
    tcfg = TokenizerConfig(image_size=32, base_channels=16, latent_channels=4, downsample=4, vq_codebook_size=64)
    acfg = ActionConfig(embed_dim=64)
    dcfg = DynamicsConfig(kind="ar", dim=64, depth=2, heads=4)
    tok = Tokenizer(tcfg)
    enc = ActionEncoder(acfg)
    n_tokens = (tcfg.image_size // tcfg.downsample) ** 2  # 64
    ar = ARTransition(dcfg, n_tokens=n_tokens, codebook_size=tcfg.vq_codebook_size, action_dim=acfg.embed_dim)
    return tok, enc, ar, n_tokens


def _build_transitions(tok, enc):
    roll = make_rollouts(n=1, seq_len=8, size=32, seed=3)[0]
    with torch.no_grad():
        idx = tok.tokenize(roll.frames)            # (8, 8, 8)
    tokens = idx.flatten(1)                          # (8, 64)
    action = enc(roll.buttons[:-1], roll.camera[:-1])  # (7, embed)
    return tokens[:-1], tokens[1:], action.detach()


def test_ar_forward_shape():
    tok, enc, ar, n = _setup()
    prev, nxt, act = _build_transitions(tok, enc)
    logits = ar(prev, nxt, act)
    assert logits.shape == (prev.shape[0], n, ar.codebook_size)


def test_ar_generate_shape():
    tok, enc, ar, n = _setup()
    prev, nxt, act = _build_transitions(tok, enc)
    gen = ar.generate(prev, act)
    assert gen.shape == (prev.shape[0], n)
    assert int(gen.min()) >= 0 and int(gen.max()) < ar.codebook_size


def test_ar_overfits_token_dynamics():
    tok, enc, ar, n = _setup()
    prev, nxt, act = _build_transitions(tok, enc)
    opt = torch.optim.Adam(ar.parameters(), lr=2e-3)
    first = None
    last = 0.0
    for _ in range(250):
        loss = ar.loss(prev, nxt, act)
        opt.zero_grad()
        loss.backward()
        opt.step()
        if first is None:
            first = loss.item()
        last = loss.item()
    # token accuracy on the (teacher-forced) training transitions
    with torch.no_grad():
        acc = (ar(prev, nxt, act).argmax(-1) == nxt).float().mean().item()
    assert first is not None
    assert last < first * 0.5, f"loss did not drop: {first:.3f} -> {last:.3f}"
    assert acc > 0.85, f"token accuracy too low: {acc:.3f}"
