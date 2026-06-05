import { describe, it, expect } from "vitest";
import {
  getBedrockMapPalette,
  getCrossEditionMapPalette,
  getJavaBlockPalette,
  getSolidBlockMapPalette,
} from "../src/index";

describe("bedrock map palette", () => {
  it("has the same 244 colors as Java (shared filled-map table)", () => {
    const b = getBedrockMapPalette();
    expect(b.edition).toBe("bedrock");
    expect(b.usableColorCount).toBe(244);
  });

  it("cross-edition intersection resolves to the full shared table", () => {
    const x = getCrossEditionMapPalette();
    expect(x.colors.length).toBe(244); // no divergence → does not throw
  });
});

describe("java block palette", () => {
  const bp = getJavaBlockPalette();

  it("has 61 renderable bases each with a representative block", () => {
    expect(bp.baseCount).toBe(61);
    expect(bp.bases.length).toBe(61);
    expect(bp.bases.every((b) => b.representative !== null)).toBe(true);
  });

  it("offers the 16 solid concrete colors, all biome-independent and support-free", () => {
    // solid concrete only — concrete_powder is gravity-affected (support-required)
    const concrete = bp.bases
      .flatMap((b) => b.blocks)
      .filter((blk) => blk.id.endsWith("_concrete"));
    expect(concrete.length).toBe(16);
    expect(concrete.every((c) => !c.biomeDependent && !c.supportRequired)).toBe(true);
    const white = concrete.find((c) => c.id === "minecraft:white_concrete");
    expect(white).toBeDefined();
  });

  it("flags biome-dependent blocks (grass/leaves) so they're excluded from the solid set", () => {
    const biome = bp.bases.flatMap((b) => b.blocks).filter((blk) => blk.biomeDependent);
    expect(biome.length).toBeGreaterThan(0);
  });
});

describe("solid block map palette (for color matching)", () => {
  const { palette, blockByMapColorId } = getSolidBlockMapPalette();

  it("yields a MapPalette of biome-independent solid blocks", () => {
    expect(palette.colors.length).toBeGreaterThanOrEqual(16);
    for (const c of palette.colors) {
      const block = blockByMapColorId.get(c.mapColorId);
      expect(block).toBeDefined();
      expect(block!.biomeDependent).toBe(false);
      expect(block!.supportRequired).toBe(false);
    }
  });
});
