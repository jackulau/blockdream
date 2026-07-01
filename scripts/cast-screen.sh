#!/usr/bin/env bash
# cast-screen.sh - one command to screen-share ANY screen/window/tab into a LIVE Minecraft block
# wall. Starts the bridge (a local port that serves a capture page AND relays its frames into a
# running vanilla server over RCON - no Fabric, no mods, no datapack). Open the URL it prints,
# click "Share a screen", pick a source: it appears live as blocks at --origin while you watch
# from inside Minecraft.
#
#   scripts/cast-screen.sh --rcon-pass <pw>                                  # then open http://127.0.0.1:8770
#   scripts/cast-screen.sh --rcon-pass <pw> --origin 100,70,-20 --facing east --setup
#   scripts/cast-screen.sh --rcon-pass <pw> --size 160x90 --fps 8            # bigger, faster wall
#   scripts/cast-screen.sh --dry-run                                         # serve the page, paint nothing
#
# One long-running prereq (unless --dry-run): a stock vanilla server with RCON -
#   bash scripts/vanilla-server.sh   (prints the RCON password once). No world-model server needed.
# Full flow + the transport: docs/screen-share.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pull --port and --host out of the args (just to print the right URL); everything is still
# forwarded verbatim to the bridge CLI, which owns all real argument parsing + validation.
PORT=8770
HOST=127.0.0.1
prev=""
for a in "$@"; do
  case "$prev" in
    --port) PORT="$a" ;;
    --host) HOST="$a" ;;
  esac
  prev="$a"
done

echo "screen-share bridge -> open  http://${HOST}:${PORT}  in your browser, then click \"Share a screen\"."
echo "(Ctrl-C here stops the bridge.)"
echo

exec npx tsx "${ROOT}/packages/cli/src/screenshare-bridge-cli.ts" "$@"
