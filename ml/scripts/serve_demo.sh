#!/usr/bin/env bash
# serve_demo.sh — launch the full browser world-model demo with the CORRECT checkpoints.
#
# One command brings up everything the single-page demo (apps/web) needs:
#   1. Minecraft WM server   ws://127.0.0.1:8765  ← runs/skills (skill-DISTINCT; pig/elytra/boat differ)
#   2. Driving WM server     ws://127.0.0.1:8766  ← runs/drive  (telemetry bounded, drive D1)
#   3. Web dev server        http://127.0.0.1:5173
#
# IMPORTANT: serve runs/skills, NOT runs/m4. The m4 checkpoint is real-VPT walking-only — its skill
# embeddings are dead (verify_movement_types.py → 0/36 distinct), so every movement type renders
# identical. runs/skills is skill-conditioned (29/36 distinct) so the movement dropdown actually works.
#
# Ctrl-C stops all three. Requires the venv (ml/.venv) and the checkpoints to exist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"

MC_CKPT="${MC_CKPT:-$ML/runs/skills/latest.pt}"   # skill-distinct MC checkpoint (override: MC_CKPT=...)
DRIVE_CKPT="${DRIVE_CKPT:-$ML/runs/drive/latest.pt}"
MC_PORT="${MC_PORT:-8765}"
DRIVE_PORT="${DRIVE_PORT:-8766}"

[ -x "$PY" ] || { echo "✗ no venv python at $PY — run ml/scripts/setup_venv.sh first" >&2; exit 1; }

missing=0
[ -f "$MC_CKPT" ]    || { echo "✗ MC checkpoint missing: $MC_CKPT (train: ml/scripts/goal020_train_skills.sh)" >&2; missing=1; }
[ -f "$DRIVE_CKPT" ] || { echo "✗ drive checkpoint missing: $DRIVE_CKPT (train: ml/scripts/goal020_drive.sh)" >&2; missing=1; }
[ "$missing" -eq 0 ] || exit 1

pids=()
cleanup() { echo; echo "[serve_demo] stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "[serve_demo] MC server   → $MC_CKPT  (ws://127.0.0.1:$MC_PORT)"
( cd "$ML" && "$PY" -m blockdream_wm.serve --real "$MC_CKPT" --port "$MC_PORT" ) & pids+=("$!")

echo "[serve_demo] drive server → $DRIVE_CKPT  (ws://127.0.0.1:$DRIVE_PORT)"
( cd "$ML" && "$PY" -m blockdream_wm.drive.serve --checkpoint "$DRIVE_CKPT" --port "$DRIVE_PORT" ) & pids+=("$!")

echo "[serve_demo] web dev     → http://127.0.0.1:5173"
( cd "$ROOT" && pnpm --filter web dev ) & pids+=("$!")

echo "[serve_demo] all up. Open http://127.0.0.1:5173 — switch the movement dropdown (walk→pig→elytra) to see distinct frames. Ctrl-C to stop."
wait
