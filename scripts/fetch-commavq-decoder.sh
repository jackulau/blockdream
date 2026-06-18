#!/usr/bin/env bash
# fetch-commavq-decoder.sh - download comma.ai's commaVQ VQ-VAE DECODER into ml/runs/drive/.
#
# The driving world model predicts comma's VQ tokens; this 171MB decoder (MIT, from the official
# commaai/commavq-gpt2m HuggingFace repo) turns those tokens into REAL dashcam pixels so the browser
# demo streams actual driving footage instead of a token-id heatmap. It is gitignored (single-copy
# asset, like the checkpoints) and NEVER redistributed in-repo. Idempotent: skips if already present.
#
# Usage: bash scripts/fetch-commavq-decoder.sh
#   BLOCKDREAM_DECODER_PATH=<file>  override the target file (default ml/runs/drive/commavq_decoder.bin)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BLOCKDREAM_DECODER_PATH:-$ROOT/ml/runs/drive/commavq_decoder.bin}"
URL="https://huggingface.co/commaai/commavq-gpt2m/resolve/main/decoder_pytorch_model.bin"

mkdir -p "$(dirname "$DEST")"
if [ -s "$DEST" ]; then
  echo "[fetch-commavq-decoder] ✓ $DEST already present ($(du -h "$DEST" | cut -f1 | tr -d ' ')) - skipping"
  exit 0
fi

echo "[fetch-commavq-decoder] downloading comma's VQ decoder (171MB, MIT) from $URL"
curl -fL --retry 3 -o "$DEST" "$URL"

[ -s "$DEST" ] || { echo "✗ download produced an empty file - check $URL" >&2; exit 1; }
BYTES=$(stat -f %z "$DEST" 2>/dev/null || stat -c %s "$DEST")
[ "$BYTES" -gt 100000000 ] || { echo "✗ decoder suspiciously small ($BYTES bytes) - corrupt download? removing" >&2; rm -f "$DEST"; exit 1; }

echo "[fetch-commavq-decoder] ✓ $DEST ($BYTES bytes)."
echo "[fetch-commavq-decoder] prove it: ml/.venv/bin/python ml/scripts/prove_drive_pixels.py --out /tmp/drive_proof"
echo "[fetch-commavq-decoder] then serve real footage: bash ml/scripts/serve_demo.sh"
