#!/usr/bin/env bash
# D13: make the driving world model better - more + longer sim rollouts, then a best-by-val retrain
# (the prior run hit a fixed 200k-step target with no peak-capture; best.pt now preserves the peak).
set -uo pipefail
cd "$(dirname "$0")/.."            # -> ml/
export PYTORCH_ENABLE_MPS_FALLBACK=1
PY=.venv/bin/python
mkdir -p runs/goal020
LOG="runs/goal020/drive.log"
log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# 1. richer driving data: more rollouts, longer episodes (more diverse dynamics to learn from)
N=$(ls data/drive_pool/*.npz 2>/dev/null | wc -l | tr -d ' ')
if [ "${N:-0}" -lt 300 ]; then
  log "collecting driving rollouts -> 300 longer episodes (have ${N:-0})..."
  "$PY" -m blockdream_wm.drive.collect --rollouts 300 --steps 260 --out data/drive_pool 2>&1 | tee -a "$LOG"
fi

# 2. fresh best-by-val retrain
rm -f runs/drive/latest.pt runs/drive/log.csv runs/drive/tokens.pt runs/drive/best.pt
log "training driving WM (best-by-val, bounded ~32min)..."
"$PY" -m blockdream_wm.drive.train_long --pool data/drive_pool --out runs/drive \
  --tok-steps 5000 --ar-steps 150000 --ckpt-every-min 4 --max-minutes 32 --device mps 2>&1 | tee -a "$LOG"
rc=$?
if [ -f runs/drive/best.pt ]; then cp runs/drive/best.pt runs/drive/latest.pt; log "copied best.pt -> latest.pt (peak-by-val)"; fi
log "D13 drive training done rc=$rc"
exit $rc
