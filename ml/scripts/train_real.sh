#!/usr/bin/env bash
# Automatically train our own MineWorld-style world model on REAL OpenAI VPT
# Minecraft data: fetch video+actions -> prepare -> train -> checkpoint.
#
#   bash ml/scripts/train_real.sh --quick      # 1 segment, small, CPU proof (~minutes)
#   bash ml/scripts/train_real.sh --m4          # Apple Silicon (MPS): 128px, fits 24GB
#   bash ml/scripts/train_real.sh --full        # many segments, big model (NVIDIA GPU)
#
# The checkpoint is served by:
#   ml/.venv/bin/python -m mineworld_wm.serve --real ml/checkpoints/vpt.pt
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
export PYTORCH_ENABLE_MPS_FALLBACK=1

PY=ml/.venv/bin/python
MODE="${1:---quick}"
PRESET=quick; DEVICE=auto

if [ "$MODE" = "--full" ]; then
  SEGMENTS=20; SECONDS_=60; SIZE=256; FPS=10; STEPS=8000; TOK=4000; PRESET=full
elif [ "$MODE" = "--m4" ]; then
  # 128px @ downsample-8 = 256 tokens → fits a 24GB M4 Pro on MPS (~52 frames/s).
  # Bump --segments/--steps for a better model (see docs/real-world-models.md).
  SEGMENTS="${2:-8}"; SECONDS_=30; SIZE=128; FPS=10; STEPS="${3:-3000}"; TOK=2000; PRESET=m4; DEVICE=mps
else
  SEGMENTS=1; SECONDS_=8; SIZE=64; FPS=10; STEPS=200; TOK=200
fi

DATA=ml/data/vpt_${SIZE}
CKPT=ml/checkpoints/vpt.pt

echo "[train_real] mode=$MODE preset=$PRESET device=$DEVICE  segments=$SEGMENTS ${SECONDS_}s ${SIZE}px steps=$STEPS"

# 1) fetch + prepare real VPT data (idempotent: skip if already prepared)
if [ ! -f "$DATA/frames.npy" ]; then
  "$PY" -m mineworld_wm.prepare_vpt --segments "$SEGMENTS" --seconds "$SECONDS_" \
    --size "$SIZE" --fps "$FPS" --out "$DATA"
else
  echo "[train_real] reusing prepared data at $DATA"
fi

# 2) train on the real data
"$PY" -m mineworld_wm.train_real --data "$DATA" --steps "$STEPS" --tok-steps "$TOK" \
  --preset "$PRESET" --device "$DEVICE" --out "$CKPT"

echo "[train_real] done → $CKPT"
echo "[train_real] serve it:  $PY -m mineworld_wm.serve --real $CKPT"
