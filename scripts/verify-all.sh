#!/usr/bin/env bash
# verify-all.sh — the canonical local verification gate for the whole product.
#
# Chains every suite + runtime gate in the repo. Checks that need gitignored,
# single-copy artifacts (textures, checkpoints, ONNX) or local toolchains (JDK 21)
# SKIP with an explanation + the regen command instead of failing — but any check
# that RUNS and fails exits nonzero. On the canonical dev machine nothing should skip.
#
# Usage: bash scripts/verify-all.sh
#   BLOCKDREAM_STRICT=1  — artifact-missing SKIPs become failures (canonical machine only;
#                          the BLOCKDREAM_E2E-gated live bridge run stays an allowed skip)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ML="$ROOT/ml"
PY="$ML/.venv/bin/python"
STRICT="${BLOCKDREAM_STRICT:-0}"

pass=0; skip=0
note()  { printf '\n— %s\n' "$*"; }
ok()    { pass=$((pass+1)); printf '  ✓ %s\n' "$*"; }
skipped(){
  if [ "$STRICT" = "1" ]; then
    printf '  ✗ STRICT: would skip — %s\n' "$*"
    printf '\nRESULT: %d passed, %d skipped, 1 failed\n' "$pass" "$skip"
    exit 1
  fi
  skip=$((skip+1)); printf '  ⏭ SKIP: %s\n' "$*"
}
# allowed even under STRICT (needs network + an env opt-in; not an artifact rot signal)
skipped_allowed(){ skip=$((skip+1)); printf '  ⏭ SKIP: %s\n' "$*"; }
trap 'printf "\nRESULT: %d passed, %d skipped, 1 failed\n" "$pass" "$skip"' ERR

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
  ok "driving CONTROLLABLE (runs/drive, real commaVQ)"
else
  skipped "drive control — ml/runs/drive/latest.pt absent (regen: stream real commaVQ via ml/scripts/collect_real_drive.py --stream-hf, then PROMOTE=1 ml/scripts/train_drive_real.sh; see ml/CHECKPOINTS.md)"
fi
if [ -x "$PY" ] && [ -f "$ML/runs/drive/latest.pt" ]; then
  (cd "$ML" && "$PY" scripts/eval_drive_quality.py --checkpoint runs/drive/latest.pt --quick >/dev/null)
  ok "driving QUALITY_OK (eval_drive_quality --quick: real-holdout token CE + telemetry MSE, controllability, stability)"
else
  skipped "drive quality — ml/runs/drive/latest.pt absent (gate: ml/scripts/eval_drive_quality.py --quick)"
fi
if [ -x "$PY" ]; then
  (cd "$ML" && "$PY" scripts/no_synthetic_guard.py >/dev/null)
  ok "NO SYNTHETIC in any served/live world-model path (provenance sidecars + path refs + on-disk pools)"
else
  skipped "no-synthetic guard — ml venv absent (gate: ml/scripts/no_synthetic_guard.py)"
fi
if [ -x "$PY" ] && [ -f apps/web/public/onnx/transition.onnx ]; then
  (cd "$ML" && "$PY" scripts/verify_diffusion_export.py --onnx ../apps/web/public/onnx --steps 8 >/dev/null)
  ok "diffusion ONNX export PASS"
else
  skipped "diffusion export — apps/web/public/onnx absent (regen: ml/scripts/goal020_diffusion.sh)"
fi

note "Fabric mod build (JDK 21)"
if JAVA21_HOME=$(/usr/libexec/java_home -v 21 2>/dev/null) && [ -n "$JAVA21_HOME" ]; then
  (cd mods/java-fabric && JAVA_HOME="$JAVA21_HOME" ./gradlew -q build > /tmp/fabric-build.log 2>&1)
  ok "gradle build → $(ls mods/java-fabric/build/libs/*.jar | head -1) (log: /tmp/fabric-build.log)"
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
node --check tools/mineflayer-collector/datapack-e2e.mjs
ok "node --check datapack-e2e.mjs"
if [ "${BLOCKDREAM_E2E:-}" = "1" ]; then
  node tools/mineflayer-collector/bridge-e2e.mjs >/dev/null
  ok "bridge-e2e live run (vanilla server + bot + sidecar)"
  node tools/mineflayer-collector/datapack-e2e.mjs >/dev/null
  ok "datapack-e2e live run (CLI render → vanilla server executes the datapack: /reload + setup + macro animation, cell-exact)"
else
  skipped_allowed "bridge-e2e + datapack-e2e live runs — set BLOCKDREAM_E2E=1 (needs network for the Mojang server jar + Java 21 + ffmpeg; ~35s)"
fi

printf '\nverify-all: %d passed, %d skipped — ' "$pass" "$skip"
if [ "$skip" -eq 0 ]; then echo "ALL GATES GREEN (nothing skipped)"; else echo "green with $skip skip(s) — see ⏭ lines above for regen commands"; fi
printf 'RESULT: %d passed, %d skipped, 0 failed\n' "$pass" "$skip"
