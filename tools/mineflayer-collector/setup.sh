#!/usr/bin/env bash
# setup.sh — install the mineflayer real-footage collector's deps + the headless-render shim.
#
# The collector renders a bot's first-person view via prismarine-viewer headless, which needs
# node-canvas-webgl (createCanvas-with-WebGL). That package's own native build fails on modern
# macOS/arm64, but `canvas` (3.x) + headless-gl (`gl` 8.x) DO build — so we install those and drop
# in canvas-webgl-shim.js, a faithful bridge (THREE renders into a headless-gl context; we readPixels
# + blit onto the node-canvas 2D surface for JPEG/PNG encode; gl.texImage2D is patched to accept
# ImageData/Canvas texture sources). Idempotent.
#
#   cd tools/mineflayer-collector && bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "[setup] installing mineflayer + prismarine-viewer + pathfinder + canvas + gl + rcon-client…"
npm install mineflayer prismarine-viewer mineflayer-pathfinder canvas gl rcon-client

# Provide node-canvas-webgl from the working canvas+gl via the vendored shim.
SHIM_DIR=node_modules/node-canvas-webgl/lib
mkdir -p "$SHIM_DIR"
cp canvas-webgl-shim.js "$SHIM_DIR/index.js"
cat > node_modules/node-canvas-webgl/package.json <<'JSON'
{ "name": "node-canvas-webgl", "version": "0.2.6-shim", "main": "lib/index.js" }
JSON

echo "[setup] verifying render stack…"
node -e "const{createCanvas}=require('node-canvas-webgl/lib');const c=createCanvas(64,64);const g=c.getContext('webgl');if(!g)throw new Error('no GL');console.log('[setup] OK — GL', g.getParameter(g.VERSION))"
echo "[setup] done. Collect:  node collect.mjs --host <server> --skills walk,sprint,jump,swim,boat,elytra,pig,minecart"
