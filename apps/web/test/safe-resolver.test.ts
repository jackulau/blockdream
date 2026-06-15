// Regression contract for the web export resolver: NO map-colour id may ever resolve to a
// block that's unsafe to place in a user's world - flowing water/lava, slime_block, or any
// palette entry flagged biome-dependent or support-required. This is the bug the old
// blockForBase(id>>2) showcase resolver had (it returned the raw representative).
import { describe, it, expect } from "vitest";
import { resolveBlock, safeBlockInfo } from "../src/resolve-block";
import blockPalette from "@blockdream/palette/data/java-block-palette-1.21.json";

const BANNED = new Set([
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:lava",
  "minecraft:flowing_lava",
  "minecraft:slime_block",
]);

interface PaletteBlock {
  id: string;
  biomeDependent?: boolean;
  supportRequired?: boolean;
}
const FLAGS = new Map<string, PaletteBlock>();
for (const base of (blockPalette as unknown as { bases: Array<{ blocks: PaletteBlock[] }> }).bases) {
  for (const b of base.blocks) FLAGS.set(b.id, b);
}

describe("web safe block resolver", () => {
  it("never resolves any mapColorId 0..243 to water/lava/slime or flagged-unsafe blocks", () => {
    let placeable = 0;
    for (let id = 0; id <= 243; id++) {
      const block = resolveBlock(id);
      expect(block.startsWith("minecraft:")).toBe(true);
      expect(BANNED.has(block), `mapColorId ${id} resolved to banned ${block}`).toBe(false);
      if (block === "minecraft:air") continue; // unmapped id → air fallback, fine
      placeable++;
      const flags = FLAGS.get(block);
      expect(flags, `mapColorId ${id} → ${block} not found in palette data`).toBeDefined();
      expect(flags!.biomeDependent ?? false, `${block} is biome-dependent`).toBe(false);
      expect(flags!.supportRequired ?? false, `${block} requires support`).toBe(false);
    }
    // sanity: the solid set actually covers a real palette (not everything fell through to air)
    expect(placeable).toBeGreaterThan(50);
  });

  it("safeBlockInfo display info names the block that is actually placed", () => {
    for (let id = 0; id <= 243; id++) {
      const info = safeBlockInfo(id);
      if (!info) continue;
      expect(info.id).toBe(resolveBlock(id));
      expect(info.name.length).toBeGreaterThan(0);
    }
  });
});
