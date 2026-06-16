#!/usr/bin/env bash
# train_drive_real.sh - train the SERVED driving world model on 100% REAL commaVQ data (no synthetic
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
# RGB dynamics loss (goal 035, the copy-previous fix): default 0 = legacy single-step CE. Set
# RGB_CHANGE_WEIGHT / RGB_DIV_WEIGHT to break the echo-the-previous-frame shortcut.
PYTORCH_ENABLE_MPS_FALLBACK=1 "$PY" -m blockdream_wm.drive.train_real \
  --pool "$POOL" --out "$OUT" --ar-steps "$AR_STEPS" --max-minutes "$MAX_MIN" --device "$DEVICE" \
  --rgb-change-weight "${RGB_CHANGE_WEIGHT:-0}" --rgb-div-weight "${RGB_DIV_WEIGHT:-0}" \
  --rgb-div-margin "${RGB_DIV_MARGIN:-0.5}" --prev-corrupt "${PREV_CORRUPT:-0}" \
  --rgb-roll-k "${RGB_ROLL_K:-0}" --rgb-roll-weight "${RGB_ROLL_WEIGHT:-0.5}"

if [ -f "$OUT/best.pt" ]; then cp "$OUT/best.pt" "$OUT/latest.pt"; echo "[train_drive_real] best.pt -> latest.pt"; fi
echo "[train_drive_real] verifying controllability…"
"$PY" scripts/eval_drive_control.py --checkpoint "$OUT/latest.pt"
CONTROLLABLE=$?
# Promote bar also requires beating copy-previous (not frozen) - a teacher-forced AR easily collapses to
# echoing the prev frame, which the strict-dynamics gate rejects (goal 035). Only gate this on promote.
DYNAMICS_OK=0
if [ "${PROMOTE:-0}" = "1" ]; then
  echo "[train_drive_real] verifying dynamics (strict: must beat copy-previous)…"
  "$PY" scripts/eval_drive_quality.py --checkpoint "$OUT/latest.pt" --quick --strict-dynamics; DYNAMICS_OK=$?
fi

# Promote the REAL checkpoint to the SERVED path (runs/drive) only if it is controllable AND beats copy.
# PROMOTE=1 to enable (the goal/operator sets this; plain training leaves the served model alone).
SERVED="${SERVED:-runs/drive}"
if [ "${PROMOTE:-0}" = "1" ] && [ "$CONTROLLABLE" = "0" ] && [ "$DYNAMICS_OK" = "0" ]; then
  mkdir -p "$SERVED"
  # Back up the currently-served checkpoint before overwriting (timestamp-free name; the served model
  # has been real commaVQ since goal 029, so do NOT mislabel the backup "sim").
  [ -f "$SERVED/latest.pt" ] && cp "$SERVED/latest.pt" "$SERVED/prev_served_backup.pt" && echo "[train_drive_real] backed up prior served → $SERVED/prev_served_backup.pt"
  cp "$OUT/latest.pt" "$SERVED/latest.pt"
  [ -f "$OUT/best.pt" ] && cp "$OUT/best.pt" "$SERVED/best.pt"
  "$PY" scripts/write_drive_provenance.py --served "$SERVED" --pool "$POOL"
  echo "[train_drive_real] PROMOTED real commaVQ model → $SERVED (served path is now 100% real)"
  "$PY" scripts/eval_drive_control.py --checkpoint "$SERVED/latest.pt" || true
elif [ "${PROMOTE:-0}" = "1" ]; then
  echo "[train_drive_real] NOT promoting - failed controllability ($CONTROLLABLE) or strict-dynamics ($DYNAMICS_OK)"
fi
echo "[train_drive_real] done → $OUT/latest.pt"
