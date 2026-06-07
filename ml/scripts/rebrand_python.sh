#!/usr/bin/env bash
# Final piece of the Blockdream rebrand: rename the Python world-model package
# blockdream_wm -> blockdream_wm (dir + ~180 references + pyproject + the BLOCKDREAM_LOG env var).
# Run ONLY after all ML training/serving is stopped — it renames the package the trainer imports.
# Idempotent: a second run is a no-op (nothing left matching).
set -uo pipefail
cd "$(dirname "$0")/.."   # -> ml/

# guard: refuse while a process is importing the package (trainer/server running)
if pgrep -f "blockdream_wm\.|blockdream_wm\." >/dev/null 2>&1; then
  echo "REFUSING: a trainer/server using the package is still running — stop it first." >&2
  exit 1
fi

# 1. rename the package directory (tracked move)
if [ -d src/blockdream_wm ]; then
  git mv src/blockdream_wm src/blockdream_wm 2>/dev/null || mv src/blockdream_wm src/blockdream_wm
fi

# 2. rewrite references in source/config/docs/scripts (skip envs, caches, data, runs).
# Portable (no bash-4 mapfile): NUL-delimited grep -> xargs.
n=$(grep -rlZ --include='*.py' --include='*.toml' --include='*.md' --include='*.sh' \
  --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache \
  --exclude-dir=runs --exclude-dir=data --exclude-dir=checkpoints \
  -e 'blockdream_wm' -e 'BLOCKDREAM_LOG' -e 'blockdream-wm' . 2>/dev/null \
  | tee /tmp/.rebrand_py_files | tr -dc '\0' | wc -c | tr -d ' ')
xargs -0 sed -i '' -e 's/blockdream_wm/blockdream_wm/g' -e 's/BLOCKDREAM_LOG/BLOCKDREAM_LOG/g' -e 's/blockdream-wm/blockdream-wm/g' < /tmp/.rebrand_py_files
rm -f /tmp/.rebrand_py_files

echo "python rebrand done — $n files rewritten; package now src/blockdream_wm"
echo "next: .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest -q"
