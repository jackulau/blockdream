# mineworld

Two coupled systems (see [PLAN.md](./PLAN.md)):

- **Workstream A — Block-Art Video Renderer.** GIFs/videos → Minecraft blocks/maps, in real time, color-matched, native on **both Java and Bedrock**. Shared OKLab color-matcher core → per-edition emitters.
- **Workstream B — Neural World Model.** Action-conditioned interactive Minecraft world model. Server-side MineWorld autoregressive baseline + in-browser continuous-VAE/latent-diffusion track. Demos: walking, boat, elytra, general world model, general gameplay.

## Layout

```
packages/
  palette/       # authoritative Minecraft color palettes (Java map colors 1.21.9 = 244 colors)
  color-core/    # OKLab convert, perceptual nearest-match, dithering, temporal coherence
  emit-java/     # Java .nbt / map_<n>.dat / datapack emitters          (planned)
  emit-bedrock/  # Bedrock .mcstructure emitter                        (planned)
  video/         # ffmpeg GIF/mp4 → frame extraction + grid resize     (planned)
  cli/           # mineworld render <input> ...                        (planned)
apps/web/        # upload UI + WASM quantizer preview                  (planned)
mods/
  java-fabric/   # live map-wall render loop (Fabric 1.21.x)           (planned)
  bedrock-addon/ # native render loop (behavior/resource pack)         (planned)
ml/              # Workstream B — world model (Python/PyTorch)         (planned)
```

## Dev

```bash
pnpm install
pnpm test        # vitest across packages
pnpm typecheck   # tsc -b packages
```

## Color foundation

The renderer authors a filled map's `colors` byte array **directly**, so the game does
**not** biome-tint it — all 244 Java map colors (61 bases × 4 shades, multipliers
`[180, 220, 255, 135]`) are usable verbatim and are edition-stable. Matching is done in
**OKLab** (perceptually uniform); quantization error is diffused in **linear light**.

## Status

- [x] A-D1 — color-matcher core (OKLab + FS/Bayer dither + temporal coherence), 18 tests passing.
- [ ] everything else — tracked as `/goal` deliverables (Workstream A: `001-blockart-renderer`, Workstream B: `002-world-model`).

> Operator-only steps (cannot run in this sandbox): full multi-GPU world-model training,
> live Minecraft server/client deploy, JDK-21 Fabric mod build. All code is written to be
> one-command runnable on real hardware; verifies here run at synthetic/CPU scale.
