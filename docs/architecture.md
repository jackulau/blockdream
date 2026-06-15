# Architecture

A whole-system map of the project: a Minecraft block-art renderer + a neural world model,
sharing a colour-matching core and a custom voxel engine.

## Workstreams

- **Workstream A - Block-art renderer.** Images/GIFs/videos → Minecraft blocks, colour-matched in
  OKLab, emitted for both Java and Bedrock (maps, structures, datapacks, behaviour packs). 2D
  (flat walls) and 3D (voxel builds) outputs.
- **Workstream B - Neural world model.** Action-conditioned, interactive Minecraft world model.
  A skill-conditioned autoregressive (AR) VQ-token model (served from `ml/runs/skills_real`) plus a latent-diffusion track
  exported to ONNX for a server-free, in-browser ">=30fps" engine. A separate driving world model
  reuses the same core. See [world-models-guide.md](./world-models-guide.md).

## Packages

The TypeScript monorepo (pnpm workspaces) under `packages/`:

| package | role |
|---|---|
| `color-core` | OKLab quantizer, palette prep, video temporal stability |
| `palette` | Java/Bedrock map-colour + solid-block palettes |
| `voxel` | the custom voxel engine - volumes, image→3D (`depth.ts`), animation (`animate.ts`), glTF/obj import (`gltf.ts`), video→3D (`video3d.ts`), projection |
| `emit-java` / `emit-bedrock` | map `.dat` / `.mcstructure` writers |
| `emit-commands` | vanilla datapacks + behaviour packs, 3D voxel datapacks, greedy fill optimizer |
| `nbt` | NBT read/write |
| `cli` | `blockdream render` - the end-to-end command-line renderer (incl. the `voxel3d` target) |

`apps/web` is the Vite single-page demo (three.js 3D viewer + the two world-model viewers). `ml/`
is the Python world-model stack. `mods/` holds the Java (Fabric) + Bedrock in-game players.

## Data flow

**Block-art (2D):** image/video → `color-core` quantize → `emit-*` → map/datapack/structure.

**Image → 3D:** image → quantize → `voxel/depth.ts` `imageToSolid` (subject isolation + silhouette
inflation, centered solid) → three.js greedy mesh (`apps/web/src/mesh3d.ts`) for display, or
`emit-commands` `generateVoxelDatapack` for an in-game build. See
[3d-and-animation.md](./3d-and-animation.md).

**Animation import:** glTF/.glb/.obj-sequence or a video → per-frame voxel volumes (shared world
box for temporal coherence) → playback + animated datapack. See
[video-import.md](./video-import.md).

**World model:** VPT/synthetic frames → tokenizer → AR or diffusion transition → served over
WebSocket to `apps/web` (AR) or exported to ONNX and run in-browser (diffusion).

## Build / test / run

```bash
pnpm install
pnpm -r --filter "./packages/**" build   # build all TS packages
npx vitest run                            # all JS/TS tests
pnpm --filter web dev                     # the web demo on :5173
cd ml && .venv/bin/python -m pytest       # world-model tests
```
