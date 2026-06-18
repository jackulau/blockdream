#!/usr/bin/env bash
# serve_demo.sh - launch the full browser world-model demo with the CORRECT checkpoints.
#
# One command brings up everything the single-page demo (apps/web) needs:
#   1. Minecraft WM server   ws://127.0.0.1:8765  ← runs/skills_real (skill-DISTINCT; pig/elytra/boat differ)
#   2. Driving WM server     ws://127.0.0.1:8766  ← runs/drive       (REAL comma.ai commaVQ, camera-only)
#   3. Web dev server        http://127.0.0.1:5173
#
# IMPORTANT: serve runs/skills_real, NOT runs/m4. The m4 checkpoint is real-VPT walking-only - its skill
# embeddings are dead (verify_movement_types.py → 0/36 distinct), so every movement type renders identical.
# runs/skills_real is skill-conditioned and trained on genuine real footage for all 9 movement types
# (verify_movement_types.py → 36/36 distinct, mean |Δ| 0.11), so the movement dropdown actually works.
#
# Ctrl-C stops all three. Requires the venv (ml/.venv) and the checkpoints to exist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"

MC_CKPT="${MC_CKPT:-$ML/runs/skills_real/latest.pt}"   # skill-distinct MC checkpoint (override: MC_CKPT=...)
DRIVE_CKPT="${DRIVE_CKPT:-$ML/runs/drive/latest.pt}"
MC_PORT="${MC_PORT:-8765}"
DRIVE_PORT="${DRIVE_PORT:-8766}"

[ -x "$PY" ] || { echo "✗ no venv python at $PY - run ml/scripts/setup_venv.sh first" >&2; exit 1; }

missing=0
[ -f "$MC_CKPT" ]    || { echo "✗ MC checkpoint missing: $MC_CKPT (fetch the released real model: bash scripts/fetch-checkpoint.sh)" >&2; missing=1; }
[ -f "$DRIVE_CKPT" ] || { echo "✗ drive checkpoint missing: $DRIVE_CKPT (reproduce the real commaVQ model from the committed fixture: bash ml/scripts/setup_drive_real.sh)" >&2; missing=1; }
[ "$missing" -eq 0 ] || exit 1

# commaVQ decoder (171MB, MIT) → real dashcam pixels for the driving panel. Best-effort fetch so the
# demo shows actual footage by default; without it the driving server falls back to the token field.
DECODER="${DECODER:-$ML/runs/drive/commavq_decoder.bin}"
if [ ! -s "$DECODER" ]; then
  echo "[serve_demo] commaVQ decoder absent → fetching for real-pixel driving footage…"
  bash "$ROOT/scripts/fetch-commavq-decoder.sh" || echo "[serve_demo] ⚠ decoder fetch failed; driving panel shows the token field (offline?)"
fi

pids=()
cleanup() { echo; echo "[serve_demo] stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "[serve_demo] MC server   → $MC_CKPT  (ws://127.0.0.1:$MC_PORT)"
( cd "$ML" && "$PY" -m blockdream_wm.serve --real "$MC_CKPT" --port "$MC_PORT" ) & pids+=("$!")

echo "[serve_demo] drive server → $DRIVE_CKPT  (ws://127.0.0.1:$DRIVE_PORT)"
( cd "$ML" && "$PY" -m blockdream_wm.drive.serve --checkpoint "$DRIVE_CKPT" --port "$DRIVE_PORT" ) & pids+=("$!")

echo "[serve_demo] web dev     → http://127.0.0.1:5173"
( cd "$ROOT" && pnpm --filter web dev ) & pids+=("$!")

echo "[serve_demo] all up. Open http://127.0.0.1:5173 - switch the movement dropdown (walk→pig→elytra) to see distinct frames. Ctrl-C to stop."
wait
