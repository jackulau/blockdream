"""Production long-run trainer: resumable, two-phase (tokenizer → AR), time-based
hourly checkpoints, train/val loss logging, and periodic sample-frame dumps so you
can watch Minecraft sharpen. Built for multi-day MPS runs that survive restarts.

    python -m blockdream_wm.train_long --pool ml/data/pool128 --out ml/runs/m4 \
        --preset m4 --tok-steps 40000 --ar-steps 400000 --ckpt-every-min 60

Resume is automatic: re-run the same command and it continues from out/latest.pt.
"""

from __future__ import annotations

import argparse
import csv
import os
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from .tokenizer import Tokenizer
from .transition_ar import ARTransition
from .train_real import make_config
from .data_pool import load_pools
from .movement import SkillRealEncoder, N_MOVEMENT
from .device import pick_device, device_name


def _atomic_save(obj, path: Path) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    torch.save(obj, tmp)
    os.replace(tmp, path)  # atomic - a crash mid-write can't corrupt latest.pt


def _log(out: Path, row: dict) -> None:
    f = out / "log.csv"
    new = not f.exists()
    with open(f, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["t", "phase", "step", "loss", "val", "mins"])
        if new:
            w.writeheader()
        w.writerow(row)


def _dump_sample(tok: Tokenizer, frames: torch.Tensor, val_idx: np.ndarray, out: Path, tag: str, dev) -> None:
    sel = val_idx[:4] if len(val_idx) >= 4 else np.arange(min(4, frames.shape[0]))
    x = frames[sel].to(dev).float().div(255)  # frames stored uint8 - cast at use
    with torch.no_grad():
        recon = tok(x).recon.clamp(0, 1)
    def row(t):
        return np.concatenate([(f * 255).byte().permute(1, 2, 0).cpu().numpy() for f in t], axis=1)
    strip = np.concatenate([row(x), row(recon)], axis=0)  # top=real, bottom=reconstruction
    (out / "samples").mkdir(exist_ok=True)
    Image.fromarray(strip, "RGB").resize((strip.shape[1] * 3, strip.shape[0] * 3), Image.NEAREST).save(out / "samples" / f"{tag}.png")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("blockdream_wm.train_long")
    ap.add_argument("--pool", default=None, help="single pool dir")
    ap.add_argument("--pools", default=None, help="comma-separated tagged pool dirs (multi-skill)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--preset", default="m4")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--tok-steps", type=int, default=40000)
    ap.add_argument("--ar-steps", type=int, default=400000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--ckpt-every-min", type=float, default=60.0)
    ap.add_argument("--max-minutes", type=float, default=0.0)  # 0 = until step targets
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--skill-div-weight", type=float, default=0.0,
                    help="weight of the skill-divergence aux loss (0=off). Forces movement types to "
                         "produce distinct predictions - the 128px skill-collapse fix (goal 034).")
    ap.add_argument("--skill-div-margin", type=float, default=0.5,
                    help="margin by which the true skill must out-predict a wrong skill (CE nats).")
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dev = pick_device(args.device)
    torch.manual_seed(args.seed)

    # data (one or more movement-type-tagged pools)
    dirs = args.pools.split(",") if args.pools else [args.pool]
    frames_np, actions_np, pairs, skills_np = load_pools(dirs)
    # Keep frames as uint8 on CPU and cast per-batch - float32 here would be ~4x the RAM
    # (e.g. ~16 GB for 79k 128px frames) and OOM a 24 GB unified-memory Mac mid-run.
    frames = torch.from_numpy(frames_np).permute(0, 3, 1, 2).contiguous()  # (N,3,H,W) uint8 on CPU
    buttons = torch.from_numpy(actions_np[:, :9]).float()
    camera = torch.from_numpy(actions_np[:, 9:]).float()
    skills = torch.from_numpy(skills_np).long()
    H = frames.shape[2]
    cfg = make_config(H, args.preset)
    n_tokens = cfg.latent_size**2

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(pairs))
    n_val = max(1, int(len(pairs) * args.val_frac))
    val_pairs, train_pairs = pairs[perm[:n_val]], pairs[perm[n_val:]]
    val_frames_idx = np.unique(val_pairs.reshape(-1))

    tok = Tokenizer(cfg.tokenizer).to(dev)
    enc = SkillRealEncoder(cfg.action, N_MOVEMENT).to(dev)  # movement-type conditioned
    ar = ARTransition(cfg.dynamics, n_tokens=n_tokens, codebook_size=cfg.tokenizer.vq_codebook_size, action_dim=cfg.action.embed_dim).to(dev)
    tok_opt = torch.optim.Adam(tok.parameters(), lr=args.lr)
    ar_opt = torch.optim.Adam(list(ar.parameters()) + list(enc.parameters()), lr=args.lr)

    # resume
    phase, tok_step, ar_step = "tok", 0, 0
    latest = out / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location=dev, weights_only=False)
        tok.load_state_dict(ck["tok"]); enc.load_state_dict(ck["enc"]); ar.load_state_dict(ck["ar"])
        tok_opt.load_state_dict(ck["tok_opt"]); ar_opt.load_state_dict(ck["ar_opt"])
        phase, tok_step, ar_step = ck["phase"], ck["tok_step"], ck["ar_step"]
        print(f"[train_long] RESUMED phase={phase} tok_step={tok_step} ar_step={ar_step}")

    print(f"[train_long] {frames.shape[0]} frames @ {H}px, {len(pairs)} pairs  device={device_name(dev)}  preset={args.preset}")
    t0 = time.time()
    last_ckpt = t0

    best_val = [float("inf")]
    best_path = out / "best.pt"

    def _state():
        return {"phase": phase, "tok_step": tok_step, "ar_step": ar_step,
                "config": cfg.to_dict(), "kind": "ar",
                "skill_conditioned": True, "n_skills": N_MOVEMENT,
                "tok": tok.state_dict(), "enc": enc.state_dict(), "ar": ar.state_dict(),
                "tok_opt": tok_opt.state_dict(), "ar_opt": ar_opt.state_dict(),
                "tokenizer": tok.state_dict(), "action": enc.state_dict(), "transition": ar.state_dict(),
                "init_frame": frames[0].float().div(255).clone()}

    def save(tag: str, loss: float, val: float):
        _atomic_save(_state(), latest)
        # keep the BEST-by-val checkpoint too: AR val loss can rise late on small data (overfit),
        # which collapses per-skill divergence - best.pt preserves the peak model to serve/export.
        if val > 0 and val < best_val[0]:
            best_val[0] = val
            _atomic_save(_state(), best_path)
        _log(out, {"t": int(time.time()), "phase": phase, "step": tok_step if phase == "tok" else ar_step,
                   "loss": round(loss, 4), "val": round(val, 4), "mins": round((time.time() - t0) / 60, 1)})
        _dump_sample(tok, frames, val_frames_idx, out, tag, dev)

    def time_up() -> bool:
        if (out / "STOP").exists():
            return True
        return args.max_minutes > 0 and (time.time() - t0) / 60 >= args.max_minutes

    def maybe_ckpt(loss, val):
        nonlocal last_ckpt
        if (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
            save(f"{phase}_{tok_step if phase=='tok' else ar_step:08d}", loss, val)
            last_ckpt = time.time()
            torch.mps.empty_cache() if dev.type == "mps" else None

    # ---- PHASE 1: tokenizer ----
    while phase == "tok" and tok_step < args.tok_steps and not time_up():
        idx = torch.randint(0, frames.shape[0], (args.batch,))
        out_t = tok(frames[idx].to(dev).float().div(255))
        tok_opt.zero_grad(); out_t.loss.backward(); tok_opt.step()
        tok_step += 1
        maybe_ckpt(out_t.recon_loss.item(), 0.0)
    if tok_step >= args.tok_steps and phase == "tok":
        phase = "ar"
        save("tok_final", 0.0, 0.0)
        last_ckpt = time.time()

    if time_up():
        save(f"stop_{phase}", 0.0, 0.0)
        print("[train_long] time budget reached - checkpoint saved, resume to continue")
        return 0

    # precompute tokens for the pool (cached)
    tokens_path = out / "tokens.pt"
    if tokens_path.exists():
        tokens = torch.load(tokens_path, map_location="cpu")
    else:
        toks = []
        with torch.no_grad():
            for i in range(0, frames.shape[0], 64):
                toks.append(tok.tokenize(frames[i:i + 64].to(dev).float().div(255)).flatten(1).cpu())
        tokens = torch.cat(toks)
        _atomic_save(tokens, tokens_path)

    # ---- PHASE 2: AR ----
    sdw = float(getattr(args, "skill_div_weight", 0.0))   # 0 = off (backward-compatible)
    sdm = float(getattr(args, "skill_div_margin", 0.5))

    def ar_batch(pair_arr):
        sel = pair_arr[np.random.randint(0, len(pair_arr), args.batch)]
        prev = tokens[sel[:, 0]].to(dev)
        nxt = tokens[sel[:, 1]].to(dev)
        b = buttons[sel[:, 0]].to(dev); c = camera[sel[:, 0]].to(dev); sk = skills[sel[:, 0]].to(dev)
        return prev, nxt, b, c, sk

    def ar_loss(prev, nxt, b, c, sk):
        """CE under the TRUE skill, plus an optional skill-DIVERGENCE term: the true skill must predict
        the next frame better than a WRONG (shuffled) skill by a margin -> forces the model to actually
        USE the movement-type embedding instead of ignoring it (the 128px skill-collapse fix, goal 034).
        Training-only; the architecture is unchanged so existing checkpoints serve identically."""
        ce_true = ar.loss(prev, nxt, enc(b, c, skill=sk))
        if sdw <= 0 or enc.n_skills < 2:
            return ce_true, ce_true.detach()
        off = torch.randint(1, enc.n_skills, sk.shape, device=sk.device)
        sk_wrong = (sk + off) % enc.n_skills                       # guaranteed != sk
        ce_wrong = ar.loss(prev, nxt, enc(b, c, skill=sk_wrong))
        aux = torch.relu(sdm - (ce_wrong - ce_true))               # push ce_wrong > ce_true + margin
        return ce_true + sdw * aux, ce_true.detach()

    while phase == "ar" and ar_step < args.ar_steps and not time_up():
        prev, nxt, b, c, sk = ar_batch(train_pairs)
        loss, _ = ar_loss(prev, nxt, b, c, sk)
        ar_opt.zero_grad(); loss.backward(); ar_opt.step()
        ar_step += 1
        if ar_step % 50 == 0 or (time.time() - last_ckpt) / 60 >= args.ckpt_every_min:
            with torch.no_grad():
                vp, vn, vb, vc, vsk = ar_batch(val_pairs)
                val = ar.loss(vp, vn, enc(vb, vc, skill=vsk)).item()
            if val < best_val[0]:  # track the peak at every val eval (finer than the ckpt cadence)
                best_val[0] = val
                _atomic_save(_state(), best_path)
            maybe_ckpt(loss.item(), val)

    save("final", 0.0, 0.0)
    print(f"[train_long] done: phase={phase} tok_step={tok_step} ar_step={ar_step}  → {latest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
