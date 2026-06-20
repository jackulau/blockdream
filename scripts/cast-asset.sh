#!/usr/bin/env bash
# cast-asset.sh - one-command LIVE cast of YOUR OWN image/build into a RUNNING Minecraft world
# via RCON (no Fabric, no mods, no datapack, no world model). The counterpart to cast-live.sh,
# which streams the neural world model; this paints a picture, GIF, or 3D build that YOU supply.
#
#   scripts/cast-asset.sh --image logo.png  --rcon-pass <pw> --origin 100,70,-20 --facing east --setup
#   scripts/cast-asset.sh --build photo.png --rcon-pass <pw> --depth 12 --setup              # a 3D build
#   scripts/cast-asset.sh --build logo.png  --rcon-pass <pw> --animate spin --loops 0 --setup  # spinning 3D
#   scripts/cast-asset.sh --image clip.gif  --rcon-pass <pw> --fps 8 --loops 0               # looping 2D anim
#   scripts/cast-asset.sh --image logo.png  --dry-run                                        # print commands, no server
#
# --image paints a flat block wall; --build inflates it into a 3D build; --animate (with --build)
# spins/animates it. Placement is yours: --origin <x,y,z>, --facing <north|south|east|west>.
#
# One long-running prereq (printed if missing): a stock vanilla server with RCON -
#   bash scripts/vanilla-server.sh   (prints the RCON password once). No world-model server needed.
# Honest frame rates + the transport: docs/live-cast.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASS=""
IMAGE=""
BUILD=""
ORIGIN="10,-60,10"
FACING=south
SIZE="64x64"
DEPTH=""
ANIMATE=""
ANIMATE_FRAMES=""
FPS=""
LOOPS=""
SETUP=0
DRYRUN=0

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  # valued flags need a following argument - fail cleanly instead of a set -u crash on $2
  case "$1" in
    --rcon-pass|--rcon-host|--rcon-port|--image|--build|--origin|--facing|--size|--depth|--animate|--animate-frames|--fps|--loops)
      [ $# -ge 2 ] || { echo "✗ $1 needs a value (see --help)" >&2; exit 2; } ;;
  esac
  case "$1" in
    --rcon-pass)      RCON_PASS="$2";      shift 2 ;;
    --rcon-host)      RCON_HOST="$2";      shift 2 ;;
    --rcon-port)      RCON_PORT="$2";      shift 2 ;;
    --image)          IMAGE="$2";          shift 2 ;;
    --build)          BUILD="$2";          shift 2 ;;
    --origin)         ORIGIN="$2";         shift 2 ;;
    --facing)         FACING="$2";         shift 2 ;;
    --size)           SIZE="$2";           shift 2 ;;
    --depth)          DEPTH="$2";          shift 2 ;;
    --animate)        ANIMATE="$2";        shift 2 ;;
    --animate-frames) ANIMATE_FRAMES="$2"; shift 2 ;;
    --fps)            FPS="$2";            shift 2 ;;
    --loops)          LOOPS="$2";          shift 2 ;;
    --setup)          SETUP=1;             shift ;;
    --dry-run)        DRYRUN=1;            shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "✗ unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# exactly one of --image / --build
if [ -n "$IMAGE" ] && [ -n "$BUILD" ]; then echo "✗ use --image OR --build, not both (flat wall vs 3D build)" >&2; exit 2; fi
if [ -z "$IMAGE" ] && [ -z "$BUILD" ]; then echo "✗ one of --image <path> or --build <path> is required (see --help)" >&2; exit 2; fi

# ----- preflight (skipped under --dry-run: it prints commands, needs no server / rcon pass) -----
fail=0
command -v node >/dev/null 2>&1 || { echo "✗ node not on PATH - install Node 20+ and run pnpm install" >&2; fail=1; }
if [ "$DRYRUN" -eq 0 ]; then
  command -v ffmpeg >/dev/null 2>&1 || { echo "✗ ffmpeg not on PATH (decodes your image) - macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg" >&2; fail=1; }
  [ -n "$RCON_PASS" ] || { echo "✗ --rcon-pass is required for a live cast (omit only with --dry-run). scripts/vanilla-server.sh prints it once." >&2; fail=1; }
fi
[ "$fail" -eq 0 ] || exit 1

ASSET_FLAG=--image; ASSET="$IMAGE"
[ -n "$BUILD" ] && { ASSET_FLAG=--build; ASSET="$BUILD"; }

echo "[cast-asset] LIVE cast of '$ASSET' into a RUNNING world via RCON - no datapack, no world model."
[ "$DRYRUN" -eq 0 ] && echo "[cast-asset] needs a stock vanilla server (RCON) if not already up: bash scripts/vanilla-server.sh"

# ----- run the sidecar in --image/--build mode (no --ws: the world model is never contacted) -----
ARGS=("$ASSET_FLAG" "$ASSET" --origin "$ORIGIN" --facing "$FACING" --size "$SIZE")
[ -n "$DEPTH" ]          && ARGS+=(--depth "$DEPTH")
[ -n "$ANIMATE" ]        && ARGS+=(--animate "$ANIMATE")
[ -n "$ANIMATE_FRAMES" ] && ARGS+=(--animate-frames "$ANIMATE_FRAMES")
[ -n "$FPS" ]            && ARGS+=(--fps "$FPS")
[ -n "$LOOPS" ]          && ARGS+=(--loops "$LOOPS")
[ "$SETUP" -eq 1 ]       && ARGS+=(--setup)
if [ "$DRYRUN" -eq 1 ]; then
  ARGS+=(--dry-run)
  echo "[cast-asset] dry-run: prints the setblock/fill commands, contacts no server."
else
  ARGS+=(--rcon-host "$RCON_HOST" --rcon-port "$RCON_PORT" --rcon-pass "$RCON_PASS")
fi
exec npx tsx "$ROOT/packages/cli/src/rcon-bridge-cli.ts" "${ARGS[@]}"
