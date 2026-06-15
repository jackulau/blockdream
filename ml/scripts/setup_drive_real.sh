#!/usr/bin/env bash
# setup_drive_real.sh — reproduce the SERVED real driving world model on a fresh clone, from the
# COMMITTED real commaVQ fixture (tests/fixtures/commavq_real). No download, no GPU: builds a real
# pool → trains a tiny real checkpoint → promotes it to runs/drive (with a commavq-real PROVENANCE).
# This is the driving analogue of scripts/fetch-checkpoint.sh, except the drive model is cheaply
# reproducible from committed REAL data rather than pulled as a release binary.
#
#   bash ml/scripts/setup_drive_real.sh            # idempotent: no-op if runs/drive is already real
#   FORCE=1 bash ml/scripts/setup_drive_real.sh    # rebuild even if a real runs/drive exists
#
# Knobs: MAX_MIN (train minutes, default 10), AR_STEPS (default 8000), DEVICE (default mps).
set -euo pipefail
cd "$(dirname "$0")/.."        # → ml/
PY=.venv/bin/python
[ -x "$PY" ] || { echo "✗ ml/.venv missing — create it first (see ml/README or CHECKPOINTS.md)" >&2; exit 1; }

FIXTURE="tests/fixtures/commavq_real"
POOL="${POOL:-data/drive_real_pool}"
OUT="${OUT:-runs/drive_real}"
SERVED="${SERVED:-runs/drive}"

# Already real-served? (checkpoint carries real_source=commavq) → no-op unless FORCE=1.
if [ "${FORCE:-0}" != "1" ] && [ -f "$SERVED/latest.pt" ] && \
   "$PY" - "$SERVED/latest.pt" <<'PYEOF' 2>/dev/null
import sys, torch
ck = torch.load(sys.argv[1], map_location="cpu", weights_only=False)
sys.exit(0 if ck.get("real_source") == "commavq" else 1)
PYEOF
then
  echo "[setup_drive_real] ✓ $SERVED/latest.pt is already the real commaVQ model — nothing to do (FORCE=1 to rebuild)."
  exit 0
fi

[ -d "$FIXTURE" ] || { echo "✗ committed fixture missing: ml/$FIXTURE" >&2; exit 1; }

echo "[setup_drive_real] building real pool from committed fixture ($FIXTURE) …"
"$PY" scripts/collect_real_drive.py --commavq-dir "$FIXTURE" --out "$POOL"

echo "[setup_drive_real] training + promoting the real checkpoint → $SERVED …"
PROMOTE=1 POOL="$POOL" OUT="$OUT" SERVED="$SERVED" \
  MAX_MIN="${MAX_MIN:-10}" AR_STEPS="${AR_STEPS:-8000}" DEVICE="${DEVICE:-mps}" \
  bash scripts/train_drive_real.sh

echo "[setup_drive_real] ✓ served real driving model ready at $SERVED/latest.pt"
echo "[setup_drive_real]   verify: $PY scripts/eval_drive_control.py --checkpoint $SERVED/latest.pt"
