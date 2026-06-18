#!/usr/bin/env bash
# cast-live.sh - one-command LIVE cast of the world model into a RUNNING Minecraft world
# (no Fabric, no mods, no datapack, no game restart). Drop-in: the dream streams onto a
# block wall IN PLACE wherever you point --origin, steered by your own in-game movement.
#
# This is the live counterpart to cast.sh - which bakes a STATIC datapack you must drop in
# and load. cast-live instead runs the RCON sidecar (packages/cli/src/rcon-bridge-cli.ts)
# against a stock vanilla server + the world-model WS server, painting each generated frame
# as a solid-block wall via setblock/fill over RCON: genuinely live, genuinely mod-free, and
# it attaches to a world that is already open - nothing to install in the save.
#
#   scripts/cast-live.sh --rcon-pass <pw>                 # walk, attaches to the running world
#   scripts/cast-live.sh --rcon-pass <pw> --skill elytra --origin 10,-60,10 --size 64x64
#   scripts/cast-live.sh --dry-run                        # offline: synthetic walker, no MC/venv
#
# Two long-running prereqs (cast-live prints them if you have not started them):
#   1. stock vanilla server with RCON:   bash scripts/vanilla-server.sh   (prints the RCON pass)
#   2. world-model WS server:            bash ml/scripts/serve_demo.sh    (ws://127.0.0.1:8765)
# Then this script (a third terminal) runs the sidecar. Honest fps numbers: docs/fps-budget.md
# and docs/live-cast.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"
CKPT="$ROOT/ml/runs/skills_real/latest.pt"

RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASS=""
WS="ws://127.0.0.1:8765"
SKILL=walk
ORIGIN="10,-60,10"
SIZE="64x64"
CONNS=4
SETUP=1
DRYRUN=0

usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --rcon-pass)  RCON_PASS="$2"; shift 2 ;;
    --rcon-host)  RCON_HOST="$2"; shift 2 ;;
    --rcon-port)  RCON_PORT="$2"; shift 2 ;;
    --ws)         WS="$2";        shift 2 ;;
    --skill)      SKILL="$2";     shift 2 ;;
    --origin)     ORIGIN="$2";    shift 2 ;;
    --size)       SIZE="$2";      shift 2 ;;
    --rcon-conns) CONNS="$2";     shift 2 ;;
    --no-setup)   SETUP=0;        shift ;;
    --dry-run)    DRYRUN=1;       shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "✗ unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ----- preflight (skipped under --dry-run: it uses the mock model, needs no MC/venv/ffmpeg) -----
fail=0
command -v node >/dev/null 2>&1 || { echo "✗ node not on PATH - install Node 20+ and run pnpm install" >&2; fail=1; }
if [ "$DRYRUN" -eq 0 ]; then
  command -v ffmpeg >/dev/null 2>&1 || { echo "✗ ffmpeg not on PATH (the bridge decodes model frames) - macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg" >&2; fail=1; }
  [ -n "$RCON_PASS" ] || { echo "✗ --rcon-pass is required for a live cast (omit only with --dry-run). scripts/vanilla-server.sh prints it once on boot." >&2; fail=1; }
  # the WM SERVER is a SEPARATE process that needs the venv + checkpoint; warn (not fail) so
  # it is obvious what to start in terminal 2 - the bridge itself only needs node + ffmpeg.
  [ -x "$PY" ] || echo "⚠ no venv python at $PY - the WM server (terminal 2) needs it: run ml/scripts/setup_venv.sh" >&2
  [ -f "$CKPT" ] || echo "⚠ checkpoint missing: $CKPT - the WM server needs it: scripts/fetch-checkpoint.sh" >&2
fi
[ "$fail" -eq 0 ] || exit 1

# ----- guidance: the two prerequisite processes -----
echo "[cast-live] LIVE cast into a RUNNING world - no datapack, nothing to install in the save."
echo "[cast-live] If they are not already up, start these first (separate terminals):"
echo "             1. stock vanilla server (RCON):  bash scripts/vanilla-server.sh"
echo "             2. world-model WS server:        bash ml/scripts/serve_demo.sh   ($WS)"
echo "[cast-live] this sidecar then paints the dream onto a ${SIZE} wall at ${ORIGIN} (skill=${SKILL}, ${CONNS} RCON conns)."

# ----- run the sidecar -----
ARGS=(--ws "$WS" --skill "$SKILL" --origin "$ORIGIN" --size "$SIZE" --rcon-conns "$CONNS")
[ "$SETUP" -eq 1 ] && ARGS+=(--setup)
if [ "$DRYRUN" -eq 1 ]; then
  ARGS+=(--dry-run --frames 4)
  echo "[cast-live] dry-run: synthetic walker paints into a mock wall (no MC, no venv, no ffmpeg)."
else
  ARGS+=(--rcon-host "$RCON_HOST" --rcon-port "$RCON_PORT" --rcon-pass "$RCON_PASS")
fi
exec npx tsx "$ROOT/packages/cli/src/rcon-bridge-cli.ts" "${ARGS[@]}"
