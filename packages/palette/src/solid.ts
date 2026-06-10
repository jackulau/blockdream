// Browser-safe solid-block palette entry. index.ts's getSolidBlockMapPalette resolves the
// data file through the node-only loader (node:fs) — fine for the CLI, fatal in a browser
// bundle. This module builds the SAME shape from the canonical data JSON imported directly
// (the block-resolver pattern in @blockdream/emit-commands), so web code can quantize
// against the placeable solid-block color space without dragging node builtins in.
// Type-only imports from "./index" are erased at compile time — no runtime node:fs reach.

import type { BlockEntry, BlockPalette, MapColor, MapPalette } from "./index";
import blockPaletteData from "@blockdream/palette/data/java-block-palette-1.21.json";

export interface SolidBlockMapPalette {
  palette: MapPalette;
  blockByMapColorId: Map<number, BlockEntry>;
}

/** Pure builder shared by the node loader (index.ts) and this browser-safe entry. */
export function buildSolidBlockMapPalette(bp: BlockPalette, version: string): SolidBlockMapPalette {
  const colors: MapColor[] = [];
  const blockByMapColorId = new Map<number, BlockEntry>();
  for (const base of bp.bases) {
    const block =
      base.representative && !base.representative.biomeDependent && !base.representative.supportRequired
        ? base.representative
        : base.blocks.find((b) => !b.biomeDependent && !b.supportRequired) ?? null;
    if (!block) continue;
    const mapColorId = base.baseId * 4 + 2; // full (×255) shade
    colors.push({ mapColorId, baseId: base.baseId, shadeIndex: 2, mult: 255, ...base.rgb });
    blockByMapColorId.set(mapColorId, block);
  }
  return {
    palette: {
      edition: "java",
      version,
      source: "cross-edition solid-block set (biome-independent, support-free)",
      shadeMultipliers: [180, 220, 255, 135],
      baseCount: colors.length,
      usableColorCount: colors.length,
      note: "flat solid-block build palette; pair with shade multipliers for staircased mapart",
      colors,
    },
    blockByMapColorId,
  };
}

/**
 * Browser-safe getSolidBlockMapPalette: identical output to the node loader's for every
 * 1.21.x version (the data file is canonical across the supported line).
 */
export function getSolidBlockMapPalette(version = "1.21"): SolidBlockMapPalette {
  return buildSolidBlockMapPalette(blockPaletteData as unknown as BlockPalette, version);
}
