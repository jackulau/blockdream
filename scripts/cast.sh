#!/usr/bin/env bash
# cast.sh — one-command OFFLINE "cast the world model into Minecraft" (no Fabric, no mods).
#
# Rolls the skill-conditioned WM, encodes the dream, and emits a vanilla Java datapack .zip
# that plays the animation on a block wall in-world. Wraps ml/scripts/cast_wm_to_datapack.py
# with preflight checks and an absolute checkpoint path (the python script's default is
# cwd-sensitive; we always pass the absolute path so it works from anywhere).
#
#   scripts/cast.sh                          # walk, 24 steps → /tmp/blockdream-cast/*.zip
#   scripts/cast.sh --skill elytra --steps 48 --out /tmp/elytra-cast
#
# Flags: --skill <walk|sprint|...> --steps <N> --out <dir> --checkpoint <path>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # scripts/ -> repo root
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"

SKILL="walk"
STEPS=24
OUT="/tmp/blockdream-cast"
CKPT="$ROOT/ml/runs/skills_real/latest.pt"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skill)      SKILL="$2";  shift 2 ;;
    --steps)      STEPS="$2";  shift 2 ;;
    --out)        OUT="$2";    shift 2 ;;
    --checkpoint) CKPT="$2";   shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "✗ unknown flag: $1 (supported: --skill --steps --out --checkpoint)" >&2; exit 2 ;;
  esac
done

fail=0
[ -x "$PY" ] || { echo "✗ no venv python at $PY — run ml/scripts/setup_venv.sh first" >&2; fail=1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "✗ ffmpeg not on PATH — install it (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg)" >&2; fail=1; }
[ -f "$CKPT" ] || { echo "✗ checkpoint missing: $CKPT — fetch it with scripts/fetch-checkpoint.sh, or pass --checkpoint <path>" >&2; fail=1; }
[ "$fail" -eq 0 ] || exit 1

echo "[cast] skill=$SKILL steps=$STEPS out=$OUT"
echo "[cast] checkpoint → $CKPT"
( cd "$ML" && "$PY" scripts/cast_wm_to_datapack.py \
    --checkpoint "$CKPT" --skill "$SKILL" --steps "$STEPS" --out "$OUT" )

ZIP="$(find "$OUT" -maxdepth 1 -name '*.zip' -print 2>/dev/null | head -n 1)"
[ -n "$ZIP" ] || { echo "✗ no .zip produced in $OUT — see errors above" >&2; exit 1; }

echo
echo "[cast] done → $ZIP"
echo
echo "Drop the dream into any vanilla Java world (no mods needed):"
echo "  1. cp \"$ZIP\" \"<your world save>/datapacks/\""
echo "  2. In-game:  /reload"
echo "  3.           /function blockdream:setup"
echo "  4.           /function blockdream:start"
