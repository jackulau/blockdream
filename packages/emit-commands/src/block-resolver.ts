// mapColorId → placeable block id - the standalone form of the `resolveBlock` callback
// every command emitter here consumes (datapack.ts / datapack3d.ts / behaviorpack.ts take
// `(mapColorId) => string | undefined` plus a fallback block; callers like the CLI's render.ts
// have until now rebuilt that closure from @blockdream/palette by hand). `makeBlockResolver`
// packages that wiring once, with the same air fallback the generators apply.
//
// Browser-safe on purpose: this module imports the palette DATA file directly (the same
// pattern apps/web uses) plus the dependency-free version registry - NOT the node-only
// @blockdream/palette runtime loader (node:fs) - so re-exporting it from the package's
// browser-safe entry keeps that entry browser-safe.

import { resolveMcVersion } from "@blockdream/palette/versions";
import type { BlockPalette } from "@blockdream/palette";
import blockPaletteData from "@blockdream/palette/data/java-block-palette-1.21.json";

/** The canonical solid-block palette (stable across the whole supported 1.21.x line). */
const BLOCK_PALETTE = blockPaletteData as unknown as BlockPalette;

/** Default block for an unmapped map-colour id (matches DatapackOptions.fallbackBlock). */
export const FALLBACK_BLOCK = "minecraft:air";

export interface BlockResolverOptions {
  /** Block returned for an unmapped map-colour id. Default {@link FALLBACK_BLOCK}. */
  fallbackBlock?: string;
}

let _solidById: Map<number, string> | null = null;

/**
 * mapColorId → namespaced block id for the cross-edition-safe SOLID block set -
 * the exact mapping `getSolidBlockMapPalette` (@blockdream/palette) produces: one
 * biome-independent, support-free block per base, keyed by the base's full-shade
 * map colour id (`baseId*4 + 2`). The quantizer emits these ids; this recovers
 * the block to place. Cached (the data is one canonical file).
 */
export function solidBlockByMapColorId(): Map<number, string> {
  if (_solidById) return _solidById;
  const byId = new Map<number, string>();
  for (const base of BLOCK_PALETTE.bases) {
    const rep = base.representative;
    const block =
      rep && !rep.biomeDependent && !rep.supportRequired
        ? rep
        : base.blocks.find((b) => !b.biomeDependent && !b.supportRequired) ?? null;
    if (!block) continue;
    byId.set(base.baseId * 4 + 2, block.id); // full (×255) shade
  }
  _solidById = byId;
  return byId;
}

/**
 * Build a total `mapColorId → block id` resolver for the solid-block build path.
 * `paletteVersion` is validated against the supported version registry (throws a
 * helpful error for an unknown version, like the CLI does); every 1.21.x version
 * resolves to the one canonical block-colour file, so the mapping is identical
 * across the line. Unmapped ids resolve to the fallback (air), mirroring the
 * `resolveBlock(id) ?? fallback` the datapack generators apply internally.
 */
export function makeBlockResolver(
  paletteVersion?: string,
  opts: BlockResolverOptions = {},
): (mapColorId: number) => string {
  resolveMcVersion(paletteVersion); // validate / alias - data is canonical for the whole line
  const byId = solidBlockByMapColorId();
  const fallback = opts.fallbackBlock ?? FALLBACK_BLOCK;
  return (mapColorId: number) => byId.get(mapColorId) ?? fallback;
}
