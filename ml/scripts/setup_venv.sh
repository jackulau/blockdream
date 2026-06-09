#!/usr/bin/env bash
# Create the ml/.venv and install blockdream_wm (CPU torch).
# On macOS/Linux without CUDA this pulls the CPU torch build automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3}"
# Sanity preflight: a `-m` invocation exercises runpy+importlib, which is
# exactly what breaks on a corrupted stdlib (would otherwise build a dead venv).
if ! "$PY" -m site >/dev/null 2>&1; then
  echo "ERROR: interpreter '$PY' failed '-m site' sanity check." >&2
  echo "Its stdlib may be corrupted (check the install / reinstall Python)." >&2
  echo "Searching for a healthy fallback python..." >&2
  PY=""
  for cand in /opt/homebrew/bin/python3.13 /usr/local/bin/python3.13 \
              "$(command -v python3.13 || true)" "$(command -v python3 || true)"; do
    if [ -n "$cand" ] && "$cand" -m site >/dev/null 2>&1; then
      PY="$cand"
      echo "Using healthy fallback interpreter: $PY" >&2
      break
    fi
  done
  if [ -z "$PY" ]; then
    echo "ERROR: no healthy python found; fix your Python install and retry." >&2
    exit 1
  fi
fi
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/python -m pip install -U pip wheel >/dev/null
.venv/bin/python -m pip install -e ".[dev]"
echo "blockdream_wm venv ready: $(.venv/bin/python -c 'import torch,sys;print("torch",torch.__version__,"py",sys.version.split()[0])')"
