"""Real evaluation for the driving world model — replacing 'one summed loss + a directional
unit test' with per-modality validation error AND closed-loop rollout drift, and comparing
single-step conditioning vs the new temporal-context conditioning.

Metrics (held-out rollouts, multi-track):
  • per-modality val: RGB token accuracy, LiDAR MSE, telemetry MSE
  • closed-loop drift: roll the model forward feeding its OWN predictions back (real control
    sequence), measure telemetry trajectory error vs the simulator ground truth over N steps
  • temporal vs single-step: does a window of recent (control, telemetry) reduce drift?

  python scripts/eval_drive.py            # default
  python scripts/eval_drive.py --quick    # tiny/fast (CI)
"""

from __future__ import annotations

import argparse

import numpy as np
import torch

from mineworld_wm.config import TokenizerConfig, DynamicsConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.drive.transition import DriveTransition
from mineworld_wm.drive.collect import collect_rollout
from mineworld_wm.drive.sim import TRACK_KINDS

N_LIDAR, N_TEL, N_CTRL = 32, 6, 3


def _history(ctl: torch.Tensor, tel: torch.Tensor, t: int, h: int) -> torch.Tensor:
    """Flattened window of the last h (control, telemetry) frames before t (zero-padded)."""
    rows = []
    for k in range(h, 0, -1):
        j = t - k
        if j < 0:
            rows.append(torch.zeros(N_CTRL + N_TEL))
        else:
            rows.append(torch.cat([ctl[j], tel[j]]))
    return torch.cat(rows)


def _rollouts(tok: Tokenizer, n: int, steps: int, seed0: int):
    """Collect n multi-track rollouts → list of (tokens, lidar, tel, ctl) tensors."""
    out = []
    for i in range(n):
        from mineworld_wm.drive.sim import DriveConfig
        r = collect_rollout(steps=steps, seed=seed0 + i, cfg=DriveConfig(track=TRACK_KINDS[i % len(TRACK_KINDS)]))
        rgb = torch.from_numpy(r["rgb"]).float() / 255.0
        with torch.no_grad():
            tokens = tok.tokenize(rgb).flatten(1)
        out.append((tokens, torch.from_numpy(r["lidar"]).float(),
                    torch.from_numpy(r["telemetry"]).float(), torch.from_numpy(r["control"]).float()))
    return out


def _train(tok, rolls, n_history: int, steps: int, seed: int) -> DriveTransition:
    torch.manual_seed(seed)
    trans = DriveTransition(DynamicsConfig(kind="ar", dim=64, depth=2, heads=4),
                            n_tokens=64, codebook_size=128, n_lidar=N_LIDAR, n_telemetry=N_TEL, n_history=n_history)
    opt = torch.optim.Adam(trans.parameters(), lr=2e-3)
    for _ in range(steps):
        tk, li, te, ct = rolls[np.random.randint(len(rolls))]
        T = tk.shape[0]
        hist = torch.stack([_history(ct, te, t, n_history) for t in range(T - 1)]) if n_history else None
        loss, _ = trans.loss(tk[:-1], tk[1:], li[:-1], te[:-1], ct[:-1], li[1:], te[1:], history=hist)
        opt.zero_grad(); loss.backward(); opt.step()
    return trans


@torch.no_grad()
def _per_modality(trans: DriveTransition, rolls, n_history: int) -> dict:
    tok_acc, lid_mse, tel_mse, k = 0.0, 0.0, 0.0, 0
    for tk, li, te, ct in rolls:
        T = tk.shape[0]
        hist = torch.stack([_history(ct, te, t, n_history) for t in range(T - 1)]) if n_history else None
        c = trans._fuse(ct[:-1], li[:-1], te[:-1], hist)
        lid_mse += torch.mean((torch.sigmoid(trans.lidar_head(c)) - li[1:]) ** 2).item()
        tel_mse += torch.mean((trans.telemetry_head(c) - te[1:]) ** 2).item()
        # RGB token accuracy via teacher-forced argmax
        logits = trans.ar.forward(tk[:-1], tk[1:], c)
        tok_acc += (logits.argmax(-1) == tk[1:]).float().mean().item()
        k += 1
    return {"rgb_token_acc": tok_acc / k, "lidar_mse": lid_mse / k, "telemetry_mse": tel_mse / k}


@torch.no_grad()
def _closed_loop_drift(trans: DriveTransition, roll, n_history: int, n_steps: int) -> float:
    """Roll the model forward feeding its OWN lidar/telemetry back (real control); compare the
    predicted telemetry trajectory to the simulator's. Mean per-step L2 = drift."""
    tk, li, te, ct = roll
    pt, pl, ptel = tk[:1], li[:1], te[:1]
    hist_ct, hist_te = [ct[0]], [te[0]]
    err = 0.0
    n = min(n_steps, tk.shape[0] - 1)
    for t in range(n):
        if n_history:
            rows = []
            for kk in range(n_history, 0, -1):
                j = len(hist_ct) - kk
                rows.append(torch.cat([hist_ct[j], hist_te[j]]) if j >= 0 else torch.zeros(N_CTRL + N_TEL))
            h = torch.cat(rows).unsqueeze(0)
        else:
            h = None
        pt, pl, ptel = trans.step(pt, pl, ptel, ct[t:t + 1], history=h)
        err += torch.norm(ptel[0] - te[t + 1]).item()
        hist_ct.append(ct[t]); hist_te.append(ptel[0])
    return err / max(1, n)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    n_roll, steps, train_steps, drift_steps = (4, 16, 120, 8) if args.quick else (8, 24, 300, 15)

    tok = Tokenizer(TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=128))
    train = _rollouts(tok, n_roll, steps, seed0=0)
    val = _rollouts(tok, max(2, n_roll // 2), steps, seed0=500)

    results = {}
    for label, h in (("single-step", 0), ("temporal-ctx", 3)):
        trans = _train(tok, train, n_history=h, steps=train_steps, seed=0)
        mod = _per_modality(trans, val, h)
        drift = float(np.mean([_closed_loop_drift(trans, r, h, drift_steps) for r in val]))
        results[label] = {**mod, "drift": drift}

    print(f"\n  driving world-model eval (multi-track: {', '.join(TRACK_KINDS)})")
    print(f"  {'model':14s} {'rgb tok acc':>12s} {'lidar mse':>10s} {'tel mse':>9s} {'drift':>8s}")
    for label, m in results.items():
        print(f"  {label:14s} {m['rgb_token_acc']*100:11.0f}% {m['lidar_mse']:10.4f} {m['telemetry_mse']:9.4f} {m['drift']:8.4f}")

    s, tcx = results["single-step"], results["temporal-ctx"]
    better = tcx["drift"] <= s["drift"]
    delta = (s["drift"] - tcx["drift"]) / max(1e-9, s["drift"]) * 100
    print(f"\n  temporal-context closed-loop drift {'IMPROVES' if better else 'changes'} by {delta:+.0f}% vs single-step")
    # eval is valid if all metrics are finite + sane (lidar/tel are normalized → small)
    ok = all(np.isfinite(v) for m in results.values() for v in m.values())
    ok = ok and s["telemetry_mse"] < 0.5 and tcx["telemetry_mse"] < 0.5 and s["lidar_mse"] < 0.5
    print(f"  eval: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
