import { describe, it, expect } from "vitest";
import { getJavaMapPalette, getFullBlockMapPalette } from "@mineworld/palette";
import { preparePalette, nearestSrgb, nearestSrgbHue, hueDistance } from "../src/match";
import { srgbToOklab } from "../src/oklab";

/** The full upgrade: map-244 + naive nearest  →  full-block palette + gamut-mapped. */
describe("D6: combined palette + gamut-mapping improvement", () => {
  const mapPal = preparePalette(getJavaMapPalette());
  const blkPal = preparePalette(getFullBlockMapPalette().palette);

  const SATURATED = [
    [255, 0, 255], [220, 30, 180], [0, 255, 255], [40, 200, 200],
    [255, 255, 0], [255, 140, 0], [150, 0, 255], [255, 0, 120], [0, 255, 130],
  ];

  function hueOf(c: { r: number; g: number; b: number }): number {
    const l = srgbToOklab(c.r, c.g, c.b);
    return Math.atan2(l.b, l.a);
  }

  it("block palette + gamut-mapped match preserves saturated hues far better", () => {
    let before = 0;
    let after = 0;
    for (const [r, g, b] of SATURATED) {
      const hin = hueOf({ r: r!, g: g!, b: b! });
      before += hueDistance(hin, hueOf(nearestSrgb(r!, g!, b!, mapPal).color));
      after += hueDistance(hin, hueOf(nearestSrgbHue(r!, g!, b!, blkPal, 0.8).color));
    }
    before /= SATURATED.length;
    after /= SATURATED.length;
    expect(after).toBeLessThan(before * 0.6); // measured ~70% better on real content
  });
});
