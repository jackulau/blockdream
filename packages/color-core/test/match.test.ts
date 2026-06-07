import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, nearestSrgb } from "../src/match";

const pal = preparePalette(getJavaMapPalette());

describe("nearest match", () => {
  it("matches an exact palette color to itself", () => {
    // grass base, full shade: mapColorId 6 = (127,178,56)
    const m = nearestSrgb(127, 178, 56, pal);
    expect(m.color.mapColorId).toBe(6);
    expect(m.dist2).toBeCloseTo(0, 9);
  });

  it("matches pure white to the brightest near-white palette entry", () => {
    const m = nearestSrgb(255, 255, 255, pal);
    // closest palette color should itself be very light
    expect(m.color.r + m.color.g + m.color.b).toBeGreaterThan(600);
  });

  it("always returns a valid map color id in [4,247]", () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const m = nearestSrgb(r, g, b, pal);
          expect(m.color.mapColorId).toBeGreaterThanOrEqual(4);
          expect(m.color.mapColorId).toBeLessThanOrEqual(247);
        }
      }
    }
  });
});
