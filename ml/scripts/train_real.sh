#!/usr/bin/env bash
# Automatically train our own MineWorld-style world model on REAL OpenAI VPT
# Minecraft data: fetch video+actions -> prepare -> train -> checkpoint.
#
#   bash ml/scripts/train_real.sh --quick      # 1 segment, small, CPU proof (~minutes)
#   bash ml/scripts/train_real.sh --full        # many segments, more steps (GPU)
#
# The checkpoint is served by:
#   ml/.venv/bin/python -m mineworld_wm.serve --real ml/checkpoints/vpt.pt
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

PY=ml/.venv/bin/python
MODE="${1:---quick}"

if [ "$MODE" = "--full" ]; then
  SEGMENTS=20; SECONDS_=60; SIZE=128; FPS=10; STEPS=4000; TOK=3000
else
  SEGMENTS=1; SECONDS_=8; SIZE=64; FPS=10; STEPS=200; TOK=200
fi

DATA=ml/data/vpt_${SIZE}
CKPT=ml/checkpoints/vpt.pt

echo "[train_real] mode=$MODE  segments=$SEGMENTS  ${SECONDS_}s  ${SIZE}px  steps=$STEPS"

# 1) fetch + prepare real VPT data (idempotent: skip if already prepared)
if [ ! -f "$DATA/frames.npy" ]; then
  "$PY" -m mineworld_wm.prepare_vpt --segments "$SEGMENTS" --seconds "$SECONDS_" \
    --size "$SIZE" --fps "$FPS" --out "$DATA"
else
  echo "[train_real] reusing prepared data at $DATA"
fi

# 2) train on the real data
"$PY" -m mineworld_wm.train_real --data "$DATA" --steps "$STEPS" --tok-steps "$TOK" --out "$CKPT"

echo "[train_real] done → $CKPT"
echo "[train_real] serve it:  $PY -m mineworld_wm.serve --real $CKPT"
