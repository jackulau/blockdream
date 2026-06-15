#!/usr/bin/env bash
# fabric-install.sh - build the optional high-FPS Fabric mod (blockdream-mapwall).
#
# The project's primary paths need NO Fabric (see docs/play-without-fabric.md).
# This is the optional upgrade: per-tick map-colour swaps instead of thousands of
# setblocks per frame - cheap enough for real video on an item-frame map wall.
#
# What it does:
#   1. Preflight JDK 21 (Fabric Loom for MC 1.21.1 requires Gradle itself on Java 21)
#   2. Build the mod jar with the pinned Gradle 8.10 wrapper
#   3. Print the manual next steps (these touch YOUR Minecraft install - not automated)
#
# Usage:
#   bash scripts/fabric-install.sh                # build + print install steps
#   bash scripts/fabric-install.sh --build-only   # stop after the jar
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
MOD_DIR="$ROOT/mods/java-fabric"

BUILD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "✗ unknown flag: $arg (try --build-only)" >&2; exit 1 ;;
  esac
done

# ── 1. Preflight: JDK 21 ────────────────────────────────────────────────────────
JAVA21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
if [ -z "$JAVA21" ]; then
  cat >&2 <<'EOF'
✗ JDK 21 not found (/usr/libexec/java_home -v 21 came up empty).

  Install it:
    brew install openjdk@21

  Homebrew's openjdk@21 is keg-only and invisible to java_home until
  registered once (no sudo needed):
    ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk ~/Library/Java/JavaVirtualMachines/openjdk-21.jdk

  Then re-run this script.
EOF
  exit 1
fi
echo "[fabric-install] JDK 21     → $JAVA21"

# ── 2. Build the mod (pinned Gradle 8.10 wrapper; Loom pulls MC + mappings) ─────
echo "[fabric-install] building   → $MOD_DIR (this can take a few minutes on first run)"
( cd "$MOD_DIR" && JAVA_HOME="$JAVA21" ./gradlew -q build )

JAR="$(find "$MOD_DIR/build/libs" -name 'blockdream-mapwall-*.jar' ! -name '*-sources*' ! -name '*-dev*' | head -n1)"
[ -n "$JAR" ] || { echo "✗ build finished but no jar found in $MOD_DIR/build/libs" >&2; exit 1; }
echo "[fabric-install] jar built  → $JAR"

[ "$BUILD_ONLY" -eq 1 ] && { echo "[fabric-install] --build-only: stopping here."; exit 0; }

# ── 3. Manual next steps (these touch your Minecraft installation) ──────────────
MC_MODS="$HOME/Library/Application Support/minecraft/mods"
cat <<EOF

[fabric-install] jar is ready. The rest touches your Minecraft install, so it's manual:

  1. Install Fabric Loader for Minecraft 1.21.1 with the official installer:
       https://fabricmc.net/use/installer/

  2. Download Fabric API (the 1.21.1 build, e.g. 0.105.0+1.21.1) into your mods folder:
       https://modrinth.com/mod/fabric-api

  3. Copy the built jar into your mods folder (macOS path shown):
       cp "$JAR" "$MC_MODS/"

  4. For LIVE world-model control, drop live.json into your world save at
       <world>/blockdream/live.json
     with:
       { "url": "ws://127.0.0.1:8765", "cols": 4, "rows": 2, "skill": "walk" }
     (static playback instead: render a frame pool to <world>/blockdream/frames.bin -
      see mods/java-fabric/README.md "Wiring a wall")

  5. Start the world-model server:
       bash ml/scripts/serve_demo.sh

  6. Launch Minecraft with the Fabric 1.21.1 profile and join your world.

Full architecture + setup: docs/live-control.md
No-Fabric alternative (primary path): docs/play-without-fabric.md
EOF
