#!/usr/bin/env bash
# vanilla-server.sh — one-command vanilla Minecraft Java server bootstrap (NO mods).
#
# Downloads the OFFICIAL Minecraft 1.21.1 server jar straight from Mojang's public
# distribution (resolved live via the piston-meta version manifest, sha1-verified —
# the same artifact the official launcher ecosystem fetches). We never redistribute
# Mojang files: YOU download the jar from Mojang under your own license, and it lands
# in a GITIGNORED dir (.vanilla-server/ by default) together with world data — never
# committed, never shipped.
#
# Running a Minecraft server requires accepting the Minecraft EULA
# (https://aka.ms/MinecraftEULA). This script writes eula=true on your behalf and
# tells you so, loudly, before it does.
#
# Usage:
#   bash scripts/vanilla-server.sh                  # set up + launch (Ctrl-C stops)
#   bash scripts/vanilla-server.sh --no-start       # set up everything, don't launch
#   bash scripts/vanilla-server.sh --dir /tmp/mc --rcon-pass hunter2 --datapack out/blockdream.zip
#
# Flags:
#   --dir <path>        target dir (default: <repo>/.vanilla-server)
#   --rcon-pass <pass>  RCON password (default: reuse existing, else random 16-hex printed ONCE)
#   --datapack <zip>    copy a datapack zip into <dir>/world/datapacks/
#   --no-start          prepare everything but do not launch the server
#
# Idempotent: the ~50MB jar download is skipped when server.jar is already present
# and sha1-valid (cached verification in server.jar.sha1 keeps re-runs offline-safe).
set -euo pipefail

MC_VERSION="1.21.1"   # PINNED — the live Fabric bridge + datapacks target this version
MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.vanilla-server"
RCON_PASS=""
DATAPACK=""
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       DIR="${2:?✗ --dir needs a path}"; shift 2 ;;
    --rcon-pass) RCON_PASS="${2:?✗ --rcon-pass needs a value}"; shift 2 ;;
    --datapack)  DATAPACK="${2:?✗ --datapack needs a zip path}"; shift 2 ;;
    --no-start)  START=0; shift ;;
    -h|--help)   sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ unknown flag: $1 — run with --help for usage" >&2; exit 1 ;;
  esac
done

for tool in curl python3 shasum xxd; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ required tool missing: $tool (ships with macOS; install it and re-run)" >&2; exit 1; }
done

mkdir -p "$DIR"
JAR="$DIR/server.jar"
SHA_FILE="$DIR/server.jar.sha1"

# ---------------------------------------------------------------- server.jar
jar_valid() { [ -s "$JAR" ] && [ "$(shasum -a 1 "$JAR" | awk '{print $1}')" = "$1" ]; }

if [ -s "$SHA_FILE" ] && jar_valid "$(cat "$SHA_FILE")"; then
  echo "[vanilla-server] ✓ server.jar cached + sha1-valid ($(cat "$SHA_FILE")) — skipping download"
else
  echo "[vanilla-server] resolving Minecraft $MC_VERSION server jar via Mojang's official manifest…"
  VERSION_URL="$(curl -fsSL "$MANIFEST_URL" | python3 -c "
import json, sys
j = json.load(sys.stdin)
urls = [v['url'] for v in j['versions'] if v['id'] == '$MC_VERSION']
if not urls:
    sys.exit('version $MC_VERSION not found in Mojang manifest — manifest format changed?')
print(urls[0])
")" || { echo "✗ could not resolve $MC_VERSION from $MANIFEST_URL (network down?)" >&2; exit 1; }

  read -r SERVER_URL EXPECTED_SHA1 < <(curl -fsSL "$VERSION_URL" | python3 -c "
import json, sys
d = json.load(sys.stdin)['downloads']['server']
print(d['url'], d['sha1'])
") || { echo "✗ could not read .downloads.server from $VERSION_URL" >&2; exit 1; }

  if jar_valid "$EXPECTED_SHA1"; then
    echo "[vanilla-server] ✓ server.jar already present + sha1-valid — skipping download"
  else
    echo "[vanilla-server] downloading server jar (~50MB) from Mojang: $SERVER_URL"
    curl -fL --progress-bar -o "$JAR.tmp" "$SERVER_URL"
    mv "$JAR.tmp" "$JAR"
    jar_valid "$EXPECTED_SHA1" || {
      echo "✗ sha1 MISMATCH on downloaded server.jar (expected $EXPECTED_SHA1) — refusing to run it." >&2
      echo "  Deleted the bad jar; re-run to retry the download." >&2
      rm -f "$JAR"; exit 1
    }
    echo "[vanilla-server] ✓ sha1 verified: $EXPECTED_SHA1"
  fi
  echo "$EXPECTED_SHA1" > "$SHA_FILE"
fi

# ---------------------------------------------------------------------- EULA
cat <<EOF

================================================================================
  ⚠  MINECRAFT EULA NOTICE  ⚠
  This script is about to write eula.txt with eula=true.
  By running this server you are AGREEING to the Minecraft End User License
  Agreement:  https://aka.ms/MinecraftEULA
  If you do NOT agree, press Ctrl-C now and delete $DIR
================================================================================

EOF
printf '# accepted by scripts/vanilla-server.sh on behalf of the user — see https://aka.ms/MinecraftEULA\neula=true\n' > "$DIR/eula.txt"

# ----------------------------------------------------------------------- RCON
if [ -z "$RCON_PASS" ]; then
  existing="$(sed -n 's/^rcon\.password=//p' "$DIR/server.properties" 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    RCON_PASS="$existing"
    echo "[vanilla-server] reusing existing RCON password from $DIR/server.properties"
  else
    RCON_PASS="$(head -c 8 /dev/urandom | xxd -p)"
    echo "[vanilla-server] generated RCON password (printed ONCE — also saved in server.properties): $RCON_PASS"
  fi
fi

# ----------------------------------------------------------- server.properties
cat > "$DIR/server.properties" <<EOF
# generated by scripts/vanilla-server.sh — minimal localhost-only sandbox config
enable-rcon=true
rcon.port=25575
rcon.password=$RCON_PASS
level-type=minecraft\:flat
level-name=world
online-mode=false
server-ip=127.0.0.1
motd=blockdream
EOF

cat <<'EOF'
================================================================================
  ⚠  SECURITY  ⚠
  online-mode=false (no Mojang auth) and RCON are enabled. That is safe ONLY
  because server-ip=127.0.0.1 binds the server AND RCON to localhost — nothing
  off this machine can reach them. Do NOT change server-ip (or blank it) while
  on a shared network, or anyone on it can join unauthenticated and drive RCON.
================================================================================
EOF

# ------------------------------------------------------------------- datapack
if [ -n "$DATAPACK" ]; then
  [ -f "$DATAPACK" ] || { echo "✗ datapack not found: $DATAPACK (build one: ml/scripts/cast_wm_to_datapack.py)" >&2; exit 1; }
  mkdir -p "$DIR/world/datapacks"
  cp "$DATAPACK" "$DIR/world/datapacks/"
  echo "[vanilla-server] ✓ datapack installed: $DIR/world/datapacks/$(basename "$DATAPACK")"
fi

# --------------------------------------------------------------------- launch
if [ "$START" -eq 0 ]; then
  echo "[vanilla-server] ✓ set up complete in $DIR (--no-start: not launching)."
  echo "  Start later: bash scripts/vanilla-server.sh --dir \"$DIR\""
  exit 0
fi

JAVA="java"
if [ -x /usr/libexec/java_home ] && JAVA21_HOME=$(/usr/libexec/java_home -v 21 2>/dev/null) && [ -n "$JAVA21_HOME" ]; then
  export JAVA_HOME="$JAVA21_HOME"
  JAVA="$JAVA21_HOME/bin/java"
else
  command -v java >/dev/null 2>&1 || { echo "✗ no java on PATH — Minecraft $MC_VERSION server needs Java 21+ (install: brew install openjdk@21)" >&2; exit 1; }
  ver="$(java -version 2>&1 | awk -F'"' '/version/ {print $2; exit}')"
  major="${ver%%.*}"; [ "$major" = "1" ] && { major="${ver#1.}"; major="${major%%.*}"; }
  [ "${major:-0}" -ge 21 ] 2>/dev/null || { echo "✗ java $ver is too old — Minecraft $MC_VERSION server needs Java 21+ (install: brew install openjdk@21)" >&2; exit 1; }
fi

cat <<EOF

[vanilla-server] launching Minecraft $MC_VERSION (vanilla, localhost-only) with $JAVA
  Join: Minecraft Java $MC_VERSION → Multiplayer → Direct Connect → localhost
  RCON: 127.0.0.1:25575 (password in $DIR/server.properties)
  Stop: Ctrl-C here, or 'stop' in the server console, or RCON 'stop'.

EOF
cd "$DIR"
exec "$JAVA" -Xmx2G -jar server.jar nogui
