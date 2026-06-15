#!/usr/bin/env bash
# promote_mc_fidelity.sh - promote a retrained Minecraft WM candidate to the SERVED checkpoint
# (runs/skills_real) ONLY if it beats the current served model on BOTH visual fidelity (detail_ratio,
# eval_mc_fidelity.py) AND keeps all 9 movement types distinct (verify_movement_types.py). Backs up the
# served checkpoint first. Promote-only-if-better: a regression never reaches the demo. Goal 031.
#
#   bash ml/scripts/promote_mc_fidelity.sh runs/skills_hifi      # candidate dir
#   FORCE=1 bash ml/scripts/promote_mc_fidelity.sh runs/skills_hifi   # promote even if not better
set -euo pipefail
cd "$(dirname "$0")/.."        # -> ml/
PY=.venv/bin/python
CAND="${1:-runs/skills_hifi}"
SERVED="${SERVED:-runs/skills_real}"
[ -f "$CAND/latest.pt" ] || { echo "no candidate checkpoint at $CAND/latest.pt" >&2; exit 1; }

fidelity() { "$PY" scripts/eval_mc_fidelity.py --checkpoint "$1/latest.pt" 2>/dev/null | awk '/^FIDELITY /{print $2}'; }
distinct() { "$PY" scripts/verify_movement_types.py --checkpoint "$1/latest.pt" >/dev/null 2>&1 && echo 1 || echo 0; }

CF=$(fidelity "$CAND"); SF=$(fidelity "$SERVED" 2>/dev/null || echo 0)
CD=$(distinct "$CAND")
echo "[promote] candidate $CAND: fidelity=$CF distinct_ok=$CD"
echo "[promote] served    $SERVED: fidelity=$SF"

better=$("$PY" -c "import sys; print(1 if float('${CF:-0}')>float('${SF:-0}') else 0)")
if [ "$CD" != "1" ]; then echo "[promote] REFUSE - candidate is not 9/9 distinct"; exit 2; fi
if [ "${FORCE:-0}" != "1" ] && [ "$better" != "1" ]; then
  echo "[promote] KEEP served - candidate fidelity $CF !> served $SF (promote-only-if-better; FORCE=1 to override)"
  exit 3
fi

mkdir -p "$SERVED"
[ -f "$SERVED/latest.pt" ] && cp "$SERVED/latest.pt" "$SERVED/pre031_backup.pt" && echo "[promote] backed up served -> $SERVED/pre031_backup.pt"
cp "$CAND/latest.pt" "$SERVED/latest.pt"
[ -f "$CAND/best.pt" ] && cp "$CAND/best.pt" "$SERVED/best.pt" || true
echo "[promote] PROMOTED $CAND -> $SERVED (fidelity $SF -> $CF, 9/9 distinct)"
echo "[promote] re-verifying served..."
"$PY" scripts/eval_mc_fidelity.py --checkpoint "$SERVED/latest.pt" | grep -E 'FIDELITY' | tail -1
"$PY" scripts/verify_movement_types.py --checkpoint "$SERVED/latest.pt" | grep -E 'verdict|distinct' | tail -1
echo "[promote] restart ml/scripts/serve_demo.sh to serve the promoted model"
