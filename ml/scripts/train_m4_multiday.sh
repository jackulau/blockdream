#!/usr/bin/env bash
# Multi-day Minecraft world-model training on an Apple Silicon Mac (M4 Pro, MPS).
# Builds/extends a real VPT data pool, then runs the resumable long trainer with
# HOURLY checkpoints. Survives crashes/sleep: it auto-restarts and resumes from the
# last checkpoint. Stop any time with Ctrl-C (or `touch ml/runs/m4/STOP`).
#
#   bash ml/scripts/train_m4_multiday.sh [segments]      # default 100 (~50 min footage, ~17 GB)
#   bash ml/scripts/train_m4_multiday.sh --dry-run
#
# Watch progress: ml/runs/m4/log.csv and ml/runs/m4/samples/*.png
# Serve the latest:  ml/.venv/bin/python -m blockdream_wm.serve --real ml/runs/m4/latest.pt
set -euo pipefail
cd "$(dirname "$0")/../.."
export PYTORCH_ENABLE_MPS_FALLBACK=1

PY=ml/.venv/bin/python
POOL=ml/data/pool_m4
OUT=ml/runs/m4
SIZE=128; SECONDS_=30; FPS=10
TOK_STEPS=40000          # tokenizer first (fixed budget), then AR ~forever
AR_STEPS=5000000
CKPT_MIN=60              # hourly checkpoints

DRY=0; SEGMENTS=100
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    ''|*[!0-9]*) ;;        # ignore non-numbers
    *) SEGMENTS="$a" ;;
  esac
done

EST_GB=$(( SEGMENTS * 172 / 1024 ))
echo "[multiday] pool=$POOL out=$OUT  segments=$SEGMENTS (~$((SEGMENTS*SECONDS_/60)) min footage, ~${EST_GB} GB download)"
echo "[multiday] preset=m4 (128px/256-tok, MPS), tok-steps=$TOK_STEPS ar-steps=$AR_STEPS, checkpoint every ${CKPT_MIN} min"
echo "[multiday] resumable: re-run this command any time to continue from $OUT/latest.pt"

if [ "$DRY" = "1" ]; then echo "[multiday] --dry-run: nothing launched."; exit 0; fi

# 1) build/extend the pool (resumable — skips already-cached segments).
# Tagged "general" (VPT contractor = walking/mining). Add elytra/boat/pig by building
# more tagged pools and passing --pools (see docs/movement-types.md).
"$PY" -m blockdream_wm.data_pool --segments "$SEGMENTS" --seconds "$SECONDS_" --size "$SIZE" --fps "$FPS" --out "$POOL" --skill general

# 2) train, auto-restarting on crash (resume is automatic), until STOP or step targets
mkdir -p "$OUT"
while true; do
  if [ -f "$OUT/STOP" ]; then echo "[multiday] STOP file present — exiting."; break; fi
  if "$PY" -m blockdream_wm.train_long --pool "$POOL" --out "$OUT" --preset m4 --device mps \
        --tok-steps "$TOK_STEPS" --ar-steps "$AR_STEPS" --ckpt-every-min "$CKPT_MIN" --batch 16; then
    echo "[multiday] trainer returned 0 (step targets reached) — done."
    break
  else
    echo "[multiday] trainer crashed (rc=$?) — resuming from last checkpoint in 15s..."
    sleep 15
  fi
done
echo "[multiday] finished. Serve:  $PY -m blockdream_wm.serve --real $OUT/latest.pt"
