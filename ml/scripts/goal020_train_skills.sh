#!/usr/bin/env bash
# Goal 020 / D6 — per-movement-type training.
# Generates synthetic per-skill pools (distinct, learnable dynamics) in the real
# on-disk format, then trains ONE skill-conditioned model on all 9 types so the
# tester's movement selector produces DISTINCT rollouts. Bounded to finish in-session.
# Resumable (train_long resumes from runs/skills/latest.pt). Logs to runs/goal020/skills.log.
set -uo pipefail
cd "$(dirname "$0")/.."           # -> ml/
export PYTORCH_ENABLE_MPS_FALLBACK=1
PY=.venv/bin/python
LOG_DIR=runs/goal020
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/skills.log"
SKILLS=general,walk,sprint,jump,swim,boat,elytra,pig,minecart
log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "D6 start: skills=$SKILLS"

# 1. generate per-skill pools (idempotent: skip if pool_synth_general already has npz)
if [ -z "$(ls data/pool_synth_general/*.npz 2>/dev/null || true)" ]; then
  log "generating 9 synthetic skill pools (size 64, 8 seg x 64 frames)…"
  "$PY" scripts/gen_movement_data.py --skills "$SKILLS" --segments 8 --len 64 --size 64 --out data 2>&1 | tee -a "$LOG"
else
  log "skill pools already present — skipping generation"
fi

POOLS=""
for s in ${SKILLS//,/ }; do POOLS="${POOLS:+$POOLS,}data/pool_synth_$s"; done
log "pools = $POOLS"

# 2. train skill-conditioned model, bounded.
# preset=quick → 256 tokens/frame at 64px (downsample 4) — 4x the spatial detail of m4's 64
# tokens, so the per-skill colour cast/scroll actually render; smaller dim192 net converges faster.
# Strong tokenizer (8k steps) is essential: the first run gave the tokenizer ~1min → mushy decode
# that collapsed all skills to the same blur. Fresh run (preset change → can't resume old state).
rm -f runs/skills/latest.pt runs/skills/log.csv
log "training skill-conditioned model -> runs/skills (preset=quick, bounded ~55min)…"
"$PY" -m mineworld_wm.train_long --pools "$POOLS" --out runs/skills \
  --preset quick --device mps --tok-steps 8000 --ar-steps 30000 \
  --ckpt-every-min 5 --batch 16 --max-minutes 55 2>&1 | tee -a "$LOG"
rc=$?
log "D6 training exit rc=$rc (checkpoint: runs/skills/latest.pt)"
exit $rc
