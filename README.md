# blockdream

Two coupled systems (full map in [docs/architecture.md](./docs/architecture.md)):

- **Workstream A — Block-art renderer.** Images / GIFs / videos → Minecraft blocks, colour-matched
  in OKLab, native on **both Java and Bedrock** (maps, structures, datapacks, behaviour packs). 2D
  walls *and* real 3D voxel builds, with animation + glTF/video import.
- **Workstream B — Neural world model.** Action-conditioned interactive Minecraft world model: a
  served autoregressive (MineWorld-style) model + a latent-diffusion track exported to ONNX for a
  server-free, in-browser engine. Plus a separate driving world model.

## Layout

```
packages/
  palette/        # Minecraft colour palettes (Java map colours, solid-block palette)
  color-core/     # OKLab convert, perceptual nearest-match, dithering, temporal coherence
  voxel/          # custom voxel engine: image→3D, animation, glTF/video import, projection
  emit-java/      # map_<n>.dat + frame-pool writers
  emit-bedrock/   # .mcstructure writer
  emit-commands/  # vanilla datapacks, behaviour packs, 3D voxel datapacks, greedy fill optimizer
  nbt/            # NBT read/write
  cli/            # `blockdream render <input> --target ...`  (incl. voxel3d)
apps/web/         # Vite single-page demo: three.js 3D viewer + both world-model viewers
mods/
  java-fabric/    # live map-wall render loop + world-model control bridge (Fabric 1.21.x)
  bedrock-addon/  # native render loop (behaviour pack)
ml/               # Workstream B — world model (Python / PyTorch)
```

## Documentation

- [Technical writeup & results](./docs/results.md) — architecture diagram, methods, graphics, measured numbers
- [Architecture](./docs/architecture.md) — whole-system map, packages, data flow
- [3D builds & animation](./docs/3d-and-animation.md) — image→3D, greedy meshing, animation system
- [Importing animations](./docs/video-import.md) — glTF / .glb / .obj-sequence / video → blocks
- [World models — full guide](./docs/world-models-guide.md) — models, train/serve/run, movement types, browser diffusion
- Also: [colour theory](./docs/color-theory.md), [command-block optimization](./docs/command-block-optimization.md),
  [real world models](./docs/real-world-models.md), [movement types](./docs/movement-types.md),
  [driving world model](./docs/driving-world-model.md), [live control](./docs/live-control.md),
  [load into Minecraft](./docs/load-into-minecraft.md), [fps budget](./docs/fps-budget.md)

## Dev

```bash
pnpm install
pnpm -r --filter "./packages/**" build   # build all TS packages
npx vitest run                            # all JS/TS tests
node scripts/check-docs.mjs               # docs gate
pnpm --filter web dev                     # the web demo on :5173
cd ml && .venv/bin/python -m pytest       # world-model tests
```

## Colour foundation

The renderer authors a filled map's `colors` byte array **directly**, so the game does **not**
biome-tint it — all 244 Java map colours (61 bases × 4 shades, multipliers `[180, 220, 255, 135]`)
are usable verbatim and edition-stable. Matching is in **OKLab** (perceptually uniform);
quantization error is diffused in **linear light**.

## Notes

Block textures are extracted locally from the official Minecraft client jar
(`apps/web/scripts/fetch-block-textures.py`) and are **gitignored** — never redistributed. World-
model checkpoints / data / runs are local-only (gitignored). Operator-only steps (multi-GPU
training, live server/client deploy, JDK-21 Fabric build) are one-command runnable on real
hardware; verifies here run at synthetic/CPU scale.
