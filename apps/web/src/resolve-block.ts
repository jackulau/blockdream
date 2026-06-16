// One SAFE resolver for every web path that places or names a block. blocks.ts's
// blockForBase() returns each base's raw `representative`, which can be flowing water,
// slime_block, or a biome-dependent block - fine as a colour swatch, wrong to PLACE in a
// user's world or to list as "the block you need". This wraps the canonical browser-safe
// solid-block resolver from @blockdream/emit-commands (the exact mapping the datapack /
// behaviorpack emitters place), plus display info (name + rgb) for that SAFE block.

import { solidBlockByMapColorId, AIR_MAP_COLOR_ID } from "@blockdream/emit-commands";
import blockPalette from "@blockdream/palette/data/java-block-palette-1.21.json";

export interface SafeBlockInfo {
  baseId: number;
  name: string;
  id: string;
  rgb: { r: number; g: number; b: number };
}

interface PaletteBase {
  baseId: number;
  rgb: SafeBlockInfo["rgb"];
  blocks: Array<{ id: string; displayName: string }>;
}

let BY_BASE: Map<number, SafeBlockInfo> | null = null;

function table(): Map<number, SafeBlockInfo> {
  if (BY_BASE) return BY_BASE;
  const safeIds = solidBlockByMapColorId();
  const byBase = new Map<number, SafeBlockInfo>();
  for (const base of (blockPalette as unknown as { bases: PaletteBase[] }).bases) {
    const id = safeIds.get(base.baseId * 4 + 2);
    if (!id) continue;
    const block = base.blocks.find((b) => b.id === id);
    byBase.set(base.baseId, { baseId: base.baseId, name: block?.displayName ?? id, id, rgb: base.rgb });
  }
  BY_BASE = byBase;
  return byBase;
}

/** Display info (name, id, rgb) for the SAFE placeable block of a map-colour id, or
 *  undefined for unmapped ids (callers treat those as air). The air sentinel (0) is air, NOT base 0:
 *  `0 >> 2 == 0` would otherwise resolve a projected EMPTY column to base 0's block. */
export function safeBlockInfo(mapColorId: number): SafeBlockInfo | undefined {
  if (mapColorId === AIR_MAP_COLOR_ID) return undefined;
  return table().get(mapColorId >> 2);
}

/**
 * mapColorId → placeable block id (cross-edition-safe solid set; air for the air sentinel and any
 * unmapped id). The `>> 2` accepts ANY shade of a base (a 4-shade palette / staircase shading maps to
 * the base's one safe block), but the air sentinel (0) must short-circuit to air first - `0 >> 2 == 0`
 * would otherwise place base 0's block for every transparent / projected-EMPTY cell.
 */
export function resolveBlock(mapColorId: number): string {
  if (mapColorId === AIR_MAP_COLOR_ID) return "minecraft:air";
  return table().get(mapColorId >> 2)?.id ?? "minecraft:air";
}
