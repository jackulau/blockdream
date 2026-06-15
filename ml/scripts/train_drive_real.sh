#!/usr/bin/env bash
# train_drive_real.sh — train the SERVED driving world model on 100% REAL commaVQ data (no synthetic
# sim). Pre-tokenized real comma.ai dashcam (128 tokens/frame) + real-pose-derived control/telemetry;
# camera-only (no LiDAR). The checkpoint carries real_source="commavq" so serve + eval treat it as the
# real model. Resumable (re-run to continue). Photoreal pixel decode needs comma's VQ decoder
# (operator-gated); controllability + telemetry are served + gated here.
#
#   # 1) get the real data + build the pool (see scripts/collect_real_drive.py header for the download)
#   ml/.venv/bin/python scripts/collect_real_drive.py --commavq-dir ml/data/commavq_raw --out ml/data/drive_real_pool
#   # 2) train
#   OUT=runs/drive_real ml/scripts/train_drive_real.sh
set -euo pipefail
cd "$(dirname "$0")/.."        # → ml/
PY=.venv/bin/python
POOL="${POOL:-data/drive_real_pool}"
OUT="${OUT:-runs/drive_real}"
DEVICE="${DEVICE:-mps}"
MAX_MIN="${MAX_MIN:-20}"
AR_STEPS="${AR_STEPS:-6000}"

if ! ls "$POOL"/roll_*.npz >/dev/null 2>&1; then
  echo "[train_drive_real] no real pool at $POOL."
  echo "  Build it from commaVQ first (REAL data, no synthetic):"
  echo "    $PY scripts/collect_real_drive.py --commavq-dir <downloaded commaVQ> --out $POOL"
  echo "  See scripts/collect_real_drive.py header for the one-line huggingface download."
  exit 2
fi

echo "[train_drive_real] pool=$POOL → $OUT (real commaVQ, camera-only, MPS)"
PYTORCH_ENABLE_MPS_FALLBACK=1 "$PY" -m blockdream_wm.drive.train_real \
  --pool "$POOL" --out "$OUT" --ar-steps "$AR_STEPS" --max-minutes "$MAX_MIN" --device "$DEVICE"

if [ -f "$OUT/best.pt" ]; then cp "$OUT/best.pt" "$OUT/latest.pt"; echo "[train_drive_real] best.pt -> latest.pt"; fi
echo "[train_drive_real] verifying controllability…"
"$PY" scripts/eval_drive_control.py --checkpoint "$OUT/latest.pt" || true
echo "[train_drive_real] done → $OUT/latest.pt"
