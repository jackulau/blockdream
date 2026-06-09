#!/usr/bin/env bash
# fetch-checkpoint.sh — download the released world-model checkpoint into ml/runs/skills_real/.
#
# Checkpoints are NOT in the repo (gitignored — single-copy training artifacts). The served
# Minecraft world model (runs/skills_real, all 9 movement types DISTINCT on real footage) ships
# as a GitHub release asset. This fetches it so a fresh clone can run the demo + cast paths.
#
# Usage: bash scripts/fetch-checkpoint.sh
#   BLOCKDREAM_CKPT_DIR=<dir>  override the target directory (default ml/runs/skills_real)
#   BLOCKDREAM_RELEASE=<tag>   override the release tag (default v0.1.0)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${BLOCKDREAM_RELEASE:-v0.1.0}"
DEST="${BLOCKDREAM_CKPT_DIR:-$ROOT/ml/runs/skills_real}"
REPO="jackulau/blockdream"
URL="https://github.com/$REPO/releases/download/$TAG/latest.pt"

mkdir -p "$DEST"
if [ -s "$DEST/latest.pt" ]; then
  echo "[fetch-checkpoint] ✓ $DEST/latest.pt already present ($(du -h "$DEST/latest.pt" | cut -f1 | tr -d ' ')) — skipping download"
  exit 0
fi

echo "[fetch-checkpoint] downloading $URL"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release download "$TAG" -R "$REPO" -p latest.pt -O "$DEST/latest.pt" --clobber
else
  curl -fL --retry 3 -o "$DEST/latest.pt" "$URL"
fi

[ -s "$DEST/latest.pt" ] || { echo "✗ download produced an empty file — check $URL" >&2; exit 1; }
BYTES=$(stat -f %z "$DEST/latest.pt" 2>/dev/null || stat -c %s "$DEST/latest.pt")
[ "$BYTES" -gt 10000000 ] || { echo "✗ checkpoint suspiciously small ($BYTES bytes) — corrupt download? removing" >&2; rm -f "$DEST/latest.pt"; exit 1; }
echo "[fetch-checkpoint] ✓ $DEST/latest.pt ($BYTES bytes). Try: bash scripts/cast.sh   or   bash ml/scripts/serve_demo.sh"
