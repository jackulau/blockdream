# Mineflayer collector — real per-movement-type data ("comma.ai for Minecraft")

comma.ai trains driving models on real fleet footage. This collects the Minecraft analogue: a
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bot drives each **movement type** on a real
server while we record its first-person view (mp4 via `prismarine-viewer` headless) plus, every
physics tick, the **action** (controls) and **physics telemetry** (position, velocity, yaw/pitch,
on-ground, in-water, speed). A Python importer turns that into the trainer's tagged pool format, so
the world model learns *real* per-skill dynamics instead of the synthetic stand-ins used to prove
the conditioning mechanism.

## Status — WORKING end to end (verified 2026-06-08 on macOS arm64, M4)

Produces real textured first-person mp4s for every movement type.

- **Server**: run a **1.16.5** server headless on **JDK 8** (creative / flat / offline). Version
  matters — see the render gotcha below.
- **Bot**: mineflayer connects + spawns creative; per-skill setup is pure creative API
  (`give` / `placeBlock` / `mount` / `equip` / `creative.flyTo`) — no op/commands needed (`setupSkill`).
- **Render**: `canvas` (3.x) + headless-gl (`gl` 8.x) + the `canvas-webgl-shim.js` bridge (THREE renders
  into a headless-gl context; we readPixels→blit→encode and patch `gl.texImage2D` for ImageData/Canvas
  texture sources). `collect.mjs` rolls its own capture: render each frame to PNG (camera set DIRECTLY —
  `setFirstPersonCamera` tweens over 50ms, so re-calling it per frame strands the camera at the origin),
  then assemble with `ffmpeg`. (prismarine-viewer's built-in `headless()` mp4 path finalised empty here.)

### Render gotcha — use a pre-1.18 version (1.16.5)
prismarine-viewer **1.33** `worldrenderer.addColumn` only marks sections `y = 0..255` dirty, so a
**1.18+** world (superflat ground at **y≈-60**, a *negative-Y* section) is never meshed → blank sky
(entities still render, which is the tell). A **pre-1.18** world (1.16.5: ground at y≈4, positive Y) is
meshed correctly. So the collector targets 1.16.5. (On 1.18+ you'd have to patch the section-Y loop to
cover negative Y.) `render-probe.mjs` is the one-frame check: prints `NONBLANK` when terrain renders.

**No-renderer path (walk/sprint/jump):** these are button-distinguishable in OpenAI VPT, so
`ml/scripts/extract_real_from_vpt.py` mines real action-labeled runs from `pool_m4` directly. The
renderer above is what gets the other five (swim/boat/elytra/pig/minecart).

The data contract (`ml/scripts/import_mineflayer.py`'s `ticks_to_arrays`) is unit tested
(`ml/tests/test_import_mineflayer.py`).

## 1. A server to play on

A local **1.16.5** flat creative server (offline-mode) you control — pre-1.18 so terrain meshes (see
the render gotcha above):

```bash
# download the 1.16.5 server.jar from the Mojang version manifest, then:
echo "eula=true" > eula.txt
printf 'gamemode=creative\nlevel-type=flat\ndifficulty=peaceful\nonline-mode=false\nallow-flight=true\n' > server.properties
java -Xmx2G -jar server.jar --nogui        # 1.16.5 runs on JDK 8
```

`setupSkill` in `collect.mjs` handles the per-skill world setup itself in creative (water column for
swim/boat, spawn+saddle+mount a pig, lay rails + a minecart, equip elytra + gain altitude) — no manual
server prep needed.

## 2. Collect

```bash
cd tools/mineflayer-collector
bash setup.sh            # installs deps + the canvas-webgl render shim (see Status)
node collect.mjs --host localhost --port 25565 \
  --skills walk,sprint,jump,swim,boat,elytra,pig,minecart \
  --seconds 30 --fps 10 --size 128
# -> out/<skill>.mp4  +  out/<skill>.json   (frames + per-tick action & physics)
```

> **Back up `out/` — it is irreplaceable SOURCE footage.** `out/*.mp4` + `out/*.json` are the raw
> recordings everything downstream is derived from, and they are swallowed by the generic `out/`
> gitignore (never committed). Copy them somewhere safe before deleting anything or re-running the
> collector — a re-run **overwrites** existing `out/<skill>.mp4` / `out/<skill>.json` in place.

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
