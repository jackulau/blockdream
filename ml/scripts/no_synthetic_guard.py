"""no_synthetic_guard.py - mechanically prove ZERO synthetic data in the live/served world-model path.

The served world models MUST be trained on 100% REAL data:
  • Minecraft WM (runs/skills_real) - real OpenAI VPT footage (walk/general/sprint/jump) + real
    mineflayer gameplay footage (swim/boat/elytra/pig/minecart).
  • Driving WM (runs/drive)         - real comma.ai commaVQ dashcam footage (camera tokens + pose).

This guard fails (exit 1) if ANY of these hold:
  1. A served checkpoint is missing its PROVENANCE.json sidecar, or that sidecar marks synthetic:true
     or declares a non-real data_source. (Sidecars are written at promotion time by the trainers /
     promote step - they are the single source of truth a model cannot fabricate.)
  2. A canonical SERVED/LIVE trainer references a synthetic pool (pool_synth_*) or the synthetic
     generator (gen_movement_data.py). Deprecated proof-only scripts are exempt (they must carry a
     DEPRECATED banner - checked separately).
  3. A synthetic data pool (data/pool_synth_*) still contains data on disk.
  4. A script that generates synthetic data is missing its DEPRECATED banner (so nobody mistakes it
     for a live path).

Run:  ml/.venv/bin/python scripts/no_synthetic_guard.py            # served-provenance strict
      ml/.venv/bin/python scripts/no_synthetic_guard.py --json     # machine-readable summary
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ML = Path(__file__).resolve().parent.parent  # → ml/

# Served checkpoints whose data provenance MUST be real. (dir, human label)
SERVED = [
    ("runs/skills_real", "Minecraft world model"),
    ("runs/drive", "Driving world model"),
]

# Canonical trainers/collectors that feed a SERVED checkpoint - none may touch synthetic data.
# (The driving SIM trainer/collector - train_long.py, collect.py - is NO LONGER here: it is the
# deprecated synthetic path, moved to SYNTH_GENERATORS. The served driving model trains on real
# commaVQ via train_real.py + collect_real_drive.py + train_drive_real.sh.)
LIVE_TRAINERS = [
    "scripts/train_skills_hi.sh",
    "scripts/train_real.sh",
    "scripts/train_drive_real.sh",
    "scripts/collect_real_drive.py",
    "src/blockdream_wm/drive/train_real.py",
    "src/blockdream_wm/drive/commavq.py",
]

# Scripts that GENERATE synthetic data - proof-only / research, must be clearly DEPRECATED so nobody
# mistakes them for a served path. Includes the driving physics SIM (sim/collect/train_long).
SYNTH_GENERATORS = [
    "scripts/gen_movement_data.py",
    "scripts/goal020_train_skills.sh",
    "src/blockdream_wm/drive/sim.py",
    "src/blockdream_wm/drive/collect.py",
    "src/blockdream_wm/drive/train_long.py",
]

REAL_SOURCES = {"real", "vpt", "mineflayer", "vpt+mineflayer", "commavq", "commavq-real", "comma"}


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def check(strict_provenance: bool = True) -> list[str]:
    """Return a list of failure strings ([] == clean)."""
    fails: list[str] = []

    # 1. Served-checkpoint provenance sidecars.
    for rel, label in SERVED:
        d = ML / rel
        ckpt = d / "latest.pt"
        prov = d / "PROVENANCE.json"
        if not ckpt.exists():
            # Absent served checkpoint is a skip (fetched/trained by operator), not a synth failure.
            continue
        if not prov.exists():
            if strict_provenance:
                fails.append(f"{rel}: served checkpoint has no PROVENANCE.json (cannot prove real data)")
            continue
        try:
            meta = json.loads(_read(prov))
        except json.JSONDecodeError as e:
            fails.append(f"{rel}/PROVENANCE.json: invalid JSON ({e})")
            continue
        if meta.get("synthetic", None) is not False:
            fails.append(f"{rel}: PROVENANCE.json synthetic={meta.get('synthetic')!r} (must be false) - {label}")
        src = str(meta.get("data_source", "")).lower()
        if src not in REAL_SOURCES:
            fails.append(f"{rel}: PROVENANCE.json data_source={src!r} not a recognized REAL source - {label}")
        pools = meta.get("pools", [])
        synth_pools = [p for p in pools if "pool_synth" in str(p)]
        if synth_pools:
            fails.append(f"{rel}: PROVENANCE.json lists synthetic pools {synth_pools}")

    # 2. Live trainers must not reference synthetic data.
    for rel in LIVE_TRAINERS:
        p = ML / rel
        if not p.exists():
            continue
        txt = _read(p)
        for needle in ("pool_synth", "gen_movement_data"):
            # Allow mentions inside the DEPRECATED-history note (comment lines referencing the past).
            hits = [ln for ln in txt.splitlines() if needle in ln and not _is_history_comment(ln)]
            if hits:
                fails.append(f"{rel}: live trainer references synthetic '{needle}': {hits[0].strip()[:80]}")

    # 3. No synthetic data pools left on disk.
    synth_dirs = sorted((ML / "data").glob("pool_synth_*"))
    nonempty = [d for d in synth_dirs if any(d.glob("*.npz"))]
    if nonempty:
        fails.append(f"synthetic data still on disk: {[d.name for d in nonempty]}")

    # 4. Synthetic generators must be deprecated.
    for rel in SYNTH_GENERATORS:
        p = ML / rel
        if p.exists() and "DEPRECATED" not in _read(p):
            fails.append(f"{rel}: synthetic generator missing a DEPRECATED banner")

    return fails


def _is_history_comment(line: str) -> bool:
    """A comment line that talks about synthetic data in the PAST tense (deprecation note) is allowed."""
    s = line.strip()
    if not (s.startswith("#") or s.startswith("//") or '"' in s or s.startswith("*")):
        return False
    low = line.lower()
    return any(w in low for w in ("deprecated", "historical", "superseded", "no longer", "must not", "earlier proof", "not used", "not served"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("no_synthetic_guard")
    ap.add_argument("--json", action="store_true", help="emit a machine-readable summary")
    ap.add_argument("--lenient-provenance", action="store_true",
                    help="treat a missing PROVENANCE.json as a warning, not a failure")
    args = ap.parse_args(argv)

    fails = check(strict_provenance=not args.lenient_provenance)

    if args.json:
        print(json.dumps({"clean": not fails, "failures": fails}, indent=2))
    else:
        if fails:
            print("[no-synthetic-guard] FAIL - synthetic data found in the live path:")
            for f in fails:
                print(f"  ✗ {f}")
        else:
            print("[no-synthetic-guard] PASS - zero synthetic data in any served/live world-model path.")
            for rel, label in SERVED:
                prov = ML / rel / "PROVENANCE.json"
                if prov.exists():
                    m = json.loads(_read(prov))
                    print(f"  ✓ {rel}: data_source={m.get('data_source')!r} synthetic={m.get('synthetic')} - {label}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
