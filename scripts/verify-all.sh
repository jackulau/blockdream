#!/usr/bin/env bash
# verify-all.sh — the canonical local verification gate for the whole product.
#
# Chains every suite + runtime gate in the repo. Checks that need gitignored,
# single-copy artifacts (textures, checkpoints, ONNX) or local toolchains (JDK 21)
# SKIP with an explanation + the regen command instead of failing — but any check
# that RUNS and fails exits nonzero. On the canonical dev machine nothing should skip.
#
# Usage: bash scripts/verify-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"

pass=0; skip=0
note()  { printf '\n— %s\n' "$*"; }
ok()    { pass=$((pass+1)); printf '  ✓ %s\n' "$*"; }
skipped(){ skip=$((skip+1)); printf '  ⏭ SKIP: %s\n' "$*"; }

note "JS test suite (vitest)"
pnpm test >/dev/null
ok "pnpm test"

note "TypeScript typecheck"
pnpm typecheck >/dev/null
ok "pnpm typecheck"

note "web checks + build"
if [ -d apps/web/public/blocks ]; then
  (cd apps/web && pnpm run check >/dev/null)
  ok "apps/web check (emit-browser-safe, render-loop, texture-coverage)"
else
  (cd apps/web && node scripts/check-emit-browser-safe.mjs >/dev/null && node scripts/check-render-loop.mjs >/dev/null)
  ok "apps/web check (emit-browser-safe, render-loop)"
  skipped "texture-coverage — apps/web/public/blocks/ absent (extract locally: see apps/web/scripts/extract-textures docs; textures are Mojang-derived, never committed)"
fi
(cd apps/web && pnpm build >/dev/null)
ok "apps/web vite build"

note "docs gate"
node scripts/check-docs.mjs >/dev/null
ok "check-docs.mjs"

note "ML test suite (pytest)"
if [ -x "$PY" ]; then
  (cd "$ML" && "$PY" -m pytest -q >/dev/null)
  ok "ml pytest"
else
  skipped "ml pytest — no venv at ml/.venv (regen: bash ml/scripts/setup_venv.sh)"
fi

note "ML runtime gates (served checkpoints)"
if [ -x "$PY" ] && [ -f "$ML/runs/skills_real/latest.pt" ]; then
  (cd "$ML" && "$PY" scripts/verify_movement_types.py --checkpoint runs/skills_real/latest.pt >/dev/null)
  ok "movement types DISTINCT (runs/skills_real)"
else
  skipped "movement types — ml/runs/skills_real/latest.pt absent (regen: collect real footage via tools/mineflayer-collector + ml/scripts/import_mineflayer.py, then ml/scripts/train_skills_hi.sh; see ml/CHECKPOINTS.md)"
fi
if [ -x "$PY" ] && [ -f "$ML/runs/drive/latest.pt" ]; then
  (cd "$ML" && "$PY" scripts/eval_drive_control.py >/dev/null)
  ok "driving CONTROLLABLE (runs/drive)"
else
  skipped "drive control — ml/runs/drive/latest.pt absent (regen: ml/scripts/goal020_drive.sh + drive train_long rollout retrain; see ml/CHECKPOINTS.md)"
fi
if [ -x "$PY" ] && [ -f apps/web/public/onnx/transition.onnx ]; then
  (cd "$ML" && "$PY" scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx --steps 8 >/dev/null)
  ok "diffusion ONNX export PASS"
else
  skipped "diffusion export — apps/web/public/onnx absent (regen: ml/scripts/goal020_diffusion.sh)"
fi

note "Fabric mod build (JDK 21)"
if JAVA21_HOME=$(/usr/libexec/java_home -v 21 2>/dev/null) && [ -n "$JAVA21_HOME" ]; then
  (cd mods/java-fabric && JAVA_HOME="$JAVA21_HOME" ./gradlew -q build >/dev/null 2>&1)
  ok "gradle build → $(ls mods/java-fabric/build/libs/*.jar | head -1)"
else
  skipped "fabric build — no JDK 21 (install: brew install openjdk@21, then see mods/java-fabric/README.md)"
fi

note "collector syntax"
node --check tools/mineflayer-collector/collect.mjs
ok "node --check collect.mjs"

note "no-Fabric play paths"
bash -n scripts/cast.sh
ok "bash -n cast.sh"
bash -n scripts/vanilla-server.sh
ok "bash -n vanilla-server.sh"
bash -n scripts/fabric-install.sh
ok "bash -n fabric-install.sh"
npx tsx packages/cli/src/rcon-bridge-cli.ts --help >/dev/null
ok "rcon-bridge-cli --help"
node --check tools/mineflayer-collector/bridge-e2e.mjs
ok "node --check bridge-e2e.mjs"
if [ "${BLOCKDREAM_E2E:-}" = "1" ]; then
  node tools/mineflayer-collector/bridge-e2e.mjs >/dev/null
  ok "bridge-e2e live run (vanilla server + bot + sidecar)"
else
  skipped "bridge-e2e live run — set BLOCKDREAM_E2E=1 (needs network for the Mojang server jar + Java 21; ~15s)"
fi

printf '\nverify-all: %d passed, %d skipped — ' "$pass" "$skip"
if [ "$skip" -eq 0 ]; then echo "ALL GATES GREEN (nothing skipped)"; else echo "green with $skip skip(s) — see ⏭ lines above for regen commands"; fi
