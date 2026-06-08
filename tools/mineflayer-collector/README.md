# Mineflayer collector — real per-movement-type data ("comma.ai for Minecraft")

comma.ai trains driving models on real fleet footage. This collects the Minecraft analogue: a
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bot drives each **movement type** on a real
server while we record its first-person view (mp4 via `prismarine-viewer` headless) plus, every
physics tick, the **action** (controls) and **physics telemetry** (position, velocity, yaw/pitch,
on-ground, in-water, speed). A Python importer turns that into the trainer's tagged pool format, so
the world model learns *real* per-skill dynamics instead of the synthetic stand-ins used to prove
the conditioning mechanism.

## Status (verified 2026-06-07 on macOS arm64, M4)

What is wired + verified end-to-end on this machine:
- **Server**: vanilla 1.18.2 **and** 1.20.4 run headless on **JDK 17** (creative / superflat / offline).
- **Bot**: mineflayer connects + spawns in creative; per-skill setup is pure creative API
  (`give` / `placeBlock` / `mount` / `equip` / `creative.flyTo`) — no op/commands needed (`setupSkill`).
- **Deps + render stack**: `canvas` (3.x) + headless-gl (`gl` 8.x) build + run; `node-canvas-webgl`
  won't build, so `setup.sh` drops in `canvas-webgl-shim.js` (a faithful bridge — THREE renders into a
  headless-gl context, we readPixels→blit→encode, and patch `gl.texImage2D` for ImageData/Canvas
  texture sources). Entity rendering works.
- **Known blocker (operator-gated)**: prismarine-viewer's **block-terrain meshing renders blank** in
  this environment — both headless (mesh objects build with **0 vertices**) and the web viewer
  (entities render, blocks don't), across 1.18.2/1.20.4, even though the block atlas + blockStates
  load (HTTP 200). So the bot/server/deps/shim/setup are all ready, but capturing *textured terrain*
  needs an environment where prismarine-viewer meshes blocks (a different GL/driver, a Linux box, or a
  real Minecraft client recording). Run `setup.sh` + `collect.mjs` there to produce the mp4s.

**Real footage you can get with NO renderer (already done):** walk / sprint / jump are
button-distinguishable in OpenAI VPT, so `ml/scripts/extract_real_from_vpt.py` mines real,
action-labeled runs straight out of `pool_m4` → `pool_real_{sprint,jump,walk}64`. The
swim/boat/elytra/pig/minecart types are the ones that need this renderer.

The data contract (`ml/scripts/import_mineflayer.py`'s `ticks_to_arrays`) is unit tested
(`ml/tests/test_import_mineflayer.py`); the bot/render path is exercised against your server.

## 1. A server to play on

Easiest is a local flat creative server (offline-mode) you control:

- Vanilla/Paper 1.21 `server.properties`: `online-mode=false`, `gamemode=creative`,
  `level-type=minecraft:flat`, `allow-flight=true` (needed for elytra), then accept the EULA.
- For `boat` / `pig` / `minecart` / `elytra`: place the vehicle/give the items near spawn first
  (or extend `SKILL_CONTROLS` + the spawn setup in `collect.mjs` to mount them). The bundled script
  records the *controls + physics* for every skill; the richer per-vehicle mounting is yours to wire
  to your server's setup.

## 2. Collect

```bash
cd tools/mineflayer-collector
bash setup.sh            # installs deps + the canvas-webgl render shim (see Status)
node collect.mjs --host localhost --port 25565 \
  --skills walk,sprint,jump,swim,boat,elytra,pig,minecart \
  --seconds 30 --fps 10 --size 128
# -> out/<skill>.mp4  +  out/<skill>.json   (frames + per-tick action & physics)
```

## 3. Import into the trainer's pool format

```bash
ml/.venv/bin/python ml/scripts/import_mineflayer.py --in tools/mineflayer-collector/out --out ml/data
# -> ml/data/pool_real_<skill>/  (seg_00000.npz = frames+actions, physics.npy, skill.txt)
```

## 4. Train the world model on REAL per-skill data

```bash
cd ml
.venv/bin/python -m blockdream_wm.train_long \
  --pools data/pool_real_walk,data/pool_real_sprint,data/pool_real_jump,data/pool_real_swim,\
data/pool_real_boat,data/pool_real_elytra,data/pool_real_pig,data/pool_real_minecart \
  --out runs/real --preset m4 --device mps
.venv/bin/python scripts/verify_movement_types.py --checkpoint runs/real/latest.pt
```

Now the served model both **looks like real Minecraft** and produces **distinct per-movement-type
dynamics** — the photoreal-and-conditioned result that synthetic data alone can't give (and the
`physics.npy` telemetry is there to train a physics-conditioned, multimodal variant next, exactly
like the driving model's RGB+LiDAR+telemetry stack).
