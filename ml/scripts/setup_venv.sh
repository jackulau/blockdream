#!/usr/bin/env bash
# Create the ml/.venv and install blockdream_wm (CPU torch).
# On macOS/Linux without CUDA this pulls the CPU torch build automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/python -m pip install -U pip wheel >/dev/null
.venv/bin/python -m pip install -e ".[dev]"
echo "blockdream_wm venv ready: $(.venv/bin/python -c 'import torch,sys;print("torch",torch.__version__,"py",sys.version.split()[0])')"
