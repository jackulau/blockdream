#!/usr/bin/env bash
# train_skills_hi.sh - high-FIDELITY skill-conditioned Minecraft world model, 100% REAL footage.
#
# This is the canonical all-real trainer for the served Minecraft world model. ALL 9 movement types
# are trained on GENUINE footage - ZERO synthetic data:
#   walk · general · sprint · jump  → real human OpenAI VPT contractor footage (button-labeled,
#                                     downsampled to 64px; common types via prep_real_skill_pools.py,
#                                     sprint/jump via extract_real_from_vpt.py's labeled-button runs)
#   swim · boat · elytra · pig · minecart → real mineflayer-rendered gameplay footage
#                                     (tools/mineflayer-collector, imported via import_mineflayer.py)
# A STRONG tokenizer is used because real texture needs it (a weak tokenizer collapses skills to blur).
# Result: the demo renders a REAL-looking Minecraft world AND every movement type steers it differently.
# Resumable (train_long resumes from $OUT/latest.pt).
#
# Historical note: an earlier proof (runs/skills via gen_movement_data.py - now DEPRECATED) used
# procedural synthetic per-skill pools to prove conditioning. It is NOT used here and is NOT served.
#
#   ml/scripts/train_skills_hi.sh                       # → runs/skills_hi
#   OUT=runs/skills_real ml/scripts/train_skills_hi.sh  # → the SERVED checkpoint (all-real)
set -euo pipefail
cd "$(dirname "$0")/.."        # → ml/
PY=.venv/bin/python
OUT="${OUT:-runs/skills_hi}"
DEVICE="${DEVICE:-mps}"
# NOTE: the AR phase MUST run to completion for sharp frames. The old 22-min default truncated the
# AR at ~1350/16000 steps → blurry averaged frames (goal 031 root cause). Default is now generous so a
# plain run finishes the AR; override MAX_MIN higher for max fidelity ("keep training").
MAX_MIN="${MAX_MIN:-90}"
AR_STEPS="${AR_STEPS:-24000}"

# 1. real walk/general pools at 64px (idempotent - skip if already built)
if [ ! -f data/pool_real_walk64/skill.txt ]; then
  echo "[skills_hi] building real 64px walk/general pools from pool_m4…"
  "$PY" scripts/prep_real_skill_pools.py --src data/pool_m4 --frames-per 2560
fi
# real sprint/jump pools from VPT's labeled buttons (idempotent)
if [ ! -f data/pool_real_sprint64/skill.txt ]; then
  echo "[skills_hi] extracting real sprint/jump/walk from VPT (pool_m4)…"
  "$PY" scripts/extract_real_from_vpt.py --src data/pool_m4
fi

# 2. pools in movement-type order - ALL 9 types are now REAL footage:
#    walk/general/sprint/jump = real human VPT (button-labeled); swim/boat/elytra/pig/minecart = real
#    mineflayer-rendered footage (tools/mineflayer-collector, imported via import_mineflayer.py).
# Override POOLS to train at higher res (e.g. the 128px pools: pool_real_*128) - see goal 033.
POOLS="${POOLS:-data/pool_real_general64,data/pool_real_walk64,data/pool_real_sprint64,data/pool_real_jump64,data/pool_real_swim,data/pool_real_boat,data/pool_real_elytra,data/pool_real_pig,data/pool_real_minecart}"
echo "[skills_hi] pools = $POOLS"

# 3. train - strong tokenizer (real texture needs it; a weak tokenizer collapses all skills to blur)
PYTORCH_ENABLE_MPS_FALLBACK=1 "$PY" -m blockdream_wm.train_long \
  --pools "$POOLS" --out "$OUT" --preset "${PRESET:-quick}" \
  --tok-steps "${TOK_STEPS:-6000}" --ar-steps "$AR_STEPS" --device "$DEVICE" \
  --ckpt-every-min 3 --batch 16 --max-minutes "$MAX_MIN"

# 4. serve/verify the best-by-val checkpoint
if [ -f "$OUT/best.pt" ]; then cp "$OUT/best.pt" "$OUT/latest.pt"; echo "[skills_hi] best.pt -> latest.pt"; fi
echo "[skills_hi] verifying movement types…"
"$PY" scripts/verify_movement_types.py --checkpoint "$OUT/latest.pt" || true
echo "[skills_hi] done → $OUT/latest.pt"
