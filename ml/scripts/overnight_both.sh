#!/usr/bin/env bash
# Overnight: train BOTH world models sequentially on an Apple Silicon Mac (MPS).
#   Phase A — Minecraft world model (primary): gets the bulk of the night.
#   Phase B — Driving world model (fallback): a fixed cap at the end.
# Both phases are resumable with periodic checkpoints and survive sleep/crash
# (auto-restart loop). A single STOP file halts everything cleanly.
#
#   bash ml/scripts/overnight_both.sh [total_hours] [drive_minutes]
#       total_hours    default 9    whole-night budget
#       drive_minutes  default 75   Phase B cap; Phase A gets total - this
#
#   Stop everything:   touch ml/runs/overnight/STOP
#   Watch:             tail -f ml/runs/overnight/overnight.log
#                      ml/runs/m4/log.csv   ml/runs/drive/log.csv
#   Serve results:     ml/.venv/bin/python -m blockdream_wm.serve --real ml/runs/m4/latest.pt
#                      ml/.venv/bin/python -m blockdream_wm.drive.serve --checkpoint ml/runs/drive/latest.pt
set -euo pipefail
cd "$(dirname "$0")/../.."
export PYTORCH_ENABLE_MPS_FALLBACK=1
PY=ml/.venv/bin/python

TOTAL_H="${1:-9}"
DRIVE_MIN="${2:-75}"
ROOT=ml/runs/overnight
MC_OUT=ml/runs/m4
DR_OUT=ml/runs/drive
MC_POOL=ml/data/pool_m4
DR_POOL=ml/data/drive_pool
STOP="$ROOT/STOP"
mkdir -p "$ROOT" "$MC_OUT" "$DR_OUT"
# fresh run: clear any stale STOP from a previous night
rm -f "$STOP" "$MC_OUT/STOP" "$DR_OUT/STOP"

TOTAL_MIN=$(awk "BEGIN{printf \"%d\", $TOTAL_H*60}")
MC_MIN=$(( TOTAL_MIN - DRIVE_MIN ))
[ "$MC_MIN" -lt 1 ] && MC_MIN=1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$ROOT/overnight.log"; }

log "overnight start: total=${TOTAL_H}h  PhaseA(minecraft)=${MC_MIN}m  PhaseB(driving)=${DRIVE_MIN}m"
log "STOP anytime: touch $STOP"

# propagate a top-level STOP down to whichever trainer is running
propagate_stop() { [ -f "$STOP" ] && { touch "$MC_OUT/STOP" "$DR_OUT/STOP"; return 0; }; return 1; }

# ---------- Phase A: Minecraft world model ----------
log "Phase A: Minecraft WM (pool=$MC_POOL)"
if [ -z "$(ls "$MC_POOL"/*.npz 2>/dev/null || true)" ]; then
  log "Phase A: building VPT pool (100 segments)…"
  "$PY" -m blockdream_wm.data_pool --segments 100 --seconds 30 --size 128 --fps 10 --out "$MC_POOL" --skill general
fi
END_A=$(( $(date +%s) + MC_MIN * 60 ))
while :; do
  propagate_stop && { log "STOP requested — exiting during Phase A"; exit 0; }
  REM=$(( (END_A - $(date +%s)) / 60 ))
  [ "$REM" -le 0 ] && { log "Phase A budget exhausted"; break; }
  log "Phase A: train_long, ${REM}m remaining"
  if "$PY" -m blockdream_wm.train_long --pool "$MC_POOL" --out "$MC_OUT" \
        --preset m4 --device mps --tok-steps 40000 --ar-steps 5000000 \
        --ckpt-every-min 30 --batch 16 --max-minutes "$REM"; then
    log "Phase A: trainer returned 0 (time budget or step targets) — advancing"
    break
  else
    rc=$?; log "Phase A: crashed rc=$rc — resuming from $MC_OUT/latest.pt in 15s"; sleep 15
  fi
done

# ---------- Phase B: Driving world model ----------
propagate_stop && { log "STOP requested before Phase B — exiting"; exit 0; }
log "Phase B: Driving WM (pool=$DR_POOL)"
NPZ=$(ls "$DR_POOL"/*.npz 2>/dev/null | wc -l | tr -d ' ')
if [ "$NPZ" -lt 120 ]; then
  log "Phase B: scaling driving pool to 160 rollouts (have $NPZ)…"
  "$PY" -m blockdream_wm.drive.collect --rollouts 160 --steps 220 --out "$DR_POOL"
fi
END_B=$(( $(date +%s) + DRIVE_MIN * 60 ))
while :; do
  propagate_stop && { log "STOP requested — exiting during Phase B"; exit 0; }
  REM=$(( (END_B - $(date +%s)) / 60 ))
  [ "$REM" -le 0 ] && { log "Phase B budget exhausted"; break; }
  log "Phase B: drive.train_long, ${REM}m remaining"
  if "$PY" -m blockdream_wm.drive.train_long --pool "$DR_POOL" --out "$DR_OUT" \
        --device mps --tok-steps 4000 --ar-steps 200000 \
        --ckpt-every-min 20 --batch 16 --max-minutes "$REM"; then
    log "Phase B: trainer returned 0 (time budget or step targets) — done"
    break
  else
    rc=$?; log "Phase B: crashed rc=$rc — resuming from $DR_OUT/latest.pt in 15s"; sleep 15
  fi
done

log "overnight done."
log "  Minecraft: $MC_OUT/latest.pt   serve: $PY -m blockdream_wm.serve --real $MC_OUT/latest.pt"
log "  Driving:   $DR_OUT/latest.pt   serve: $PY -m blockdream_wm.drive.serve --checkpoint $DR_OUT/latest.pt"
