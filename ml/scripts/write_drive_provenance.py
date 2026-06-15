"""Stamp the served driving checkpoint's PROVENANCE.json - the single source of truth
`no_synthetic_guard.py` reads to prove the served driving world model is 100% REAL (comma.ai
commaVQ), not the deprecated physics sim. Reads the checkpoint's `real_source`, the pool's
`source.txt`, and re-runs the controllability eval so the recorded metrics are real, not asserted.

    ml/.venv/bin/python scripts/write_drive_provenance.py --served runs/drive --pool data/drive_real_pool
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

ML = Path(__file__).resolve().parent.parent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("write_drive_provenance")
    ap.add_argument("--served", default="runs/drive")
    ap.add_argument("--pool", default="data/drive_real_pool")
    args = ap.parse_args(argv)

    served = (ML / args.served) if not Path(args.served).is_absolute() else Path(args.served)
    ckpt_path = served / "latest.pt"
    if not ckpt_path.exists():
        raise SystemExit(f"no served checkpoint at {ckpt_path}")
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    real_source = ck.get("real_source")
    if real_source != "commavq":
        raise SystemExit(f"served checkpoint real_source={real_source!r} - refusing to stamp it REAL "
                         "(only a commaVQ-trained checkpoint is the real served model)")

    pool = (ML / args.pool) if not Path(args.pool).is_absolute() else Path(args.pool)
    src = (pool / "source.txt").read_text().strip() if (pool / "source.txt").exists() else "commavq-real"
    n_roll = len(list(pool.glob("roll_*.npz")))

    # Re-run the real controllability eval so the recorded numbers are observed, not claimed.
    from blockdream_wm.drive.serve import load_drive_session
    from eval_drive_control import _settled  # type: ignore
    sess = load_drive_session(str(ckpt_path), device="cpu")
    coast, _ = _settled(sess, [0.0, 0.0, 0.0])
    thr, _ = _settled(sess, [0.0, 1.0, 0.0])
    _, lyaw = _settled(sess, [1.0, 0.5, 0.0])
    _, ryaw = _settled(sess, [-1.0, 0.5, 0.0])
    controllable = bool(thr > coast + 1.0 and lyaw > ryaw + 0.03 and 0.0 <= coast <= 60.0 and 0.0 <= thr <= 60.0)

    prov = {
        "model": "Driving world model (control-conditioned, served)",
        "data_source": src,
        "synthetic": False,
        "pools": [args.pool],
        "modality": "camera-only (commaVQ VQ tokens, 128/frame, codebook 1024); NO LiDAR (commaVQ has none)",
        "control_derivation": "control + telemetry derived from comma's REAL logged ego motion "
                              "(.pose.npy: forward velocity + yaw rate) - zero synthesis",
        "n_rollouts": n_roll,
        "controllability": {
            "coast_speed_mps": round(coast, 3), "throttle_speed_mps": round(thr, 3),
            "yaw_left": round(lyaw, 3), "yaw_right": round(ryaw, 3), "controllable": controllable,
        },
        "verify": "ml/.venv/bin/python scripts/eval_drive_control.py --checkpoint runs/drive/latest.pt",
        "trainer": "scripts/train_drive_real.sh (PROMOTE=1) → blockdream_wm.drive.train_real on the real commaVQ pool",
        "note": "In-session proof trained on a small committed REAL commaVQ fixture (tests/fixtures/commavq_real). "
                "Full-scale training on more commaVQ shards is operator-gated on GPU (see CHECKPOINTS.md). "
                "The deprecated physics SIM (drive.sim/collect/train_long) is NOT served.",
        "goal": "029-world-model-all-real-no-synthetic",
    }
    if not controllable:
        raise SystemExit(f"served checkpoint is NOT controllable (coast={coast:.2f} thr={thr:.2f} "
                         f"lyaw={lyaw:.3f} ryaw={ryaw:.3f}) - refusing to stamp it as a good served model")
    out = served / "PROVENANCE.json"
    out.write_text(json.dumps(prov, indent=2))
    print(f"[write_drive_provenance] wrote {out} (data_source={src!r}, controllable={controllable})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
