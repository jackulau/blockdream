import { describe, it, expect } from "vitest";
import { getJavaMapPalette, indexByMapColorId } from "../src/index";

describe("java map palette 1.21.9", () => {
  const p = getJavaMapPalette();

  it("loads 244 usable colors (61 bases × 4 shades, NONE excluded)", () => {
    expect(p.usableColorCount).toBe(244);
    expect(p.colors.length).toBe(244);
    expect(p.baseCount).toBe(62); // includes base 0 = NONE
  });

  it("uses the canonical shade multipliers", () => {
    expect(p.shadeMultipliers).toEqual([180, 220, 255, 135]);
  });

  it("computes mapColorId = baseId*4 + shadeIndex for every entry", () => {
    for (const c of p.colors) {
      expect(c.mapColorId).toBe(c.baseId * 4 + c.shadeIndex);
      expect(c.baseId).toBeGreaterThanOrEqual(1); // base 0 excluded
      expect(c.shadeIndex).toBeGreaterThanOrEqual(0);
      expect(c.shadeIndex).toBeLessThanOrEqual(3);
    }
  });

  it("indexes by map color id", () => {
    const idx = indexByMapColorId(p);
    const grass = idx.get(6);
    expect(grass).toBeDefined();
    expect([grass!.r, grass!.g, grass!.b]).toEqual([127, 178, 56]);
  });
});
