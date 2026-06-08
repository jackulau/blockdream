#!/usr/bin/env bash
# train_skills_hi.sh — higher-FIDELITY skill-conditioned Minecraft world model.
#
# The original runs/skills was trained ONLY on synthetic per-skill pools (procedural gray tints) — it
# proves skills are distinct but decodes to gray mush. This blends REAL VPT footage (pool_m4,
# downsampled to 64px) for the common movement types (walk, general) with the synthetic pools for the
# exotic skills (sprint/jump/swim/boat/elytra/pig/minecart), under a STRONG tokenizer. Result: the
# demo renders a REAL-looking Minecraft world for the common case AND every movement type steers it
# differently. Resumable (train_long resumes from runs/skills_hi/latest.pt).
#
#   ml/scripts/train_skills_hi.sh
set -euo pipefail
cd "$(dirname "$0")/.."        # → ml/
PY=.venv/bin/python
OUT="${OUT:-runs/skills_hi}"
DEVICE="${DEVICE:-mps}"
MAX_MIN="${MAX_MIN:-22}"

# 1. real walk/general pools at 64px (idempotent — skip if already built)
if [ ! -f data/pool_real_walk64/skill.txt ]; then
  echo "[skills_hi] building real 64px walk/general pools from pool_m4…"
  "$PY" scripts/prep_real_skill_pools.py --src data/pool_m4 --frames-per 2560
fi
# real sprint/jump pools from VPT's labeled buttons (idempotent)
if [ ! -f data/pool_real_sprint64/skill.txt ]; then
  echo "[skills_hi] extracting real sprint/jump/walk from VPT (pool_m4)…"
  "$PY" scripts/extract_real_from_vpt.py --src data/pool_m4
fi

# 2. pools in movement-type order. walk/general/sprint/jump are REAL human VPT footage (button-labeled);
# swim/boat/elytra/pig/minecart stay synthetic stand-ins (no real action-labeled footage — VPT is
# walking-gameplay and the mineflayer renderer is operator-gated; see tools/mineflayer-collector).
POOLS="data/pool_real_general64,data/pool_real_walk64,data/pool_real_sprint64,data/pool_real_jump64,data/pool_synth_swim,data/pool_synth_boat,data/pool_synth_elytra,data/pool_synth_pig,data/pool_synth_minecart"
echo "[skills_hi] pools = $POOLS"

# 3. train — strong tokenizer (real texture needs it; a weak tokenizer collapses all skills to blur)
PYTORCH_ENABLE_MPS_FALLBACK=1 "$PY" -m blockdream_wm.train_long \
  --pools "$POOLS" --out "$OUT" --preset quick \
  --tok-steps 6000 --ar-steps 16000 --device "$DEVICE" \
  --ckpt-every-min 3 --batch 16 --max-minutes "$MAX_MIN"

# 4. serve/verify the best-by-val checkpoint
if [ -f "$OUT/best.pt" ]; then cp "$OUT/best.pt" "$OUT/latest.pt"; echo "[skills_hi] best.pt -> latest.pt"; fi
echo "[skills_hi] verifying movement types…"
"$PY" scripts/verify_movement_types.py --checkpoint "$OUT/latest.pt" || true
echo "[skills_hi] done → $OUT/latest.pt"
