#!/usr/bin/env bash
# D7: the browser-native diffusion path, end to end.
#   1. train LatentDiffusionTransition on real footage (pool_m4, resized, bounded)
#   2. export the TRAINED transition + decoder to ONNX (real weights) into the web app
#   3. verify the export runs few-step Euler + decodes a valid frame at real-time fps
# Run after the skill-training (D6) frees the MPS. Resumable (train_diffusion resumes latest.pt).
set -uo pipefail
cd "$(dirname "$0")/.."            # -> ml/
export PYTORCH_ENABLE_MPS_FALLBACK=1
PY=.venv/bin/python
ONNX_OUT=../apps/web/public/onnx
mkdir -p runs/goal020
LOG=runs/goal020/diffusion.log
log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "D7 step 1/3 — training diffusion WM on real footage (pool_m4 @64px, bounded ~25min)…"
"$PY" scripts/train_diffusion.py --pool data/pool_m4 --out runs/diffusion \
  --size 64 --max-frames 6000 --tok-steps 4000 --trans-steps 14000 \
  --ckpt-every-min 3 --max-minutes 25 2>&1 | tee -a "$LOG"

log "D7 step 2/3 — exporting trained ONNX (real weights) -> $ONNX_OUT…"
"$PY" -m mineworld_wm.export_onnx --checkpoint runs/diffusion/latest.pt --out "$ONNX_OUT" 2>&1 | tee -a "$LOG"

log "D7 step 3/3 — verifying the exported engine…"
"$PY" scripts/verify_diffusion_export.py --onnx "$ONNX_OUT" 2>&1 | tee -a "$LOG"
rc=$?
log "D7 done rc=$rc (onnx in $ONNX_OUT)"
exit $rc
