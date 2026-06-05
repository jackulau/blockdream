import { describe, it, expect } from "vitest";
import { getFullBlockMapPalette } from "@mineworld/palette";
import { preparePalette, nearestSrgb, nearestSrgbHue, hueDistance } from "../src/match";
import { srgbToOklab } from "../src/oklab";

const pal = preparePalette(getFullBlockMapPalette().palette);

const SATURATED = [
  [255, 0, 255], [200, 0, 200], [0, 255, 255], [0, 200, 200],
  [255, 255, 0], [255, 128, 0], [128, 0, 255], [255, 0, 128],
  [0, 255, 128], [200, 40, 160],
];

function inputHue(r: number, g: number, b: number): number {
  const l = srgbToOklab(r, g, b);
  return Math.atan2(l.b, l.a);
}
function colorHue(c: { r: number; g: number; b: number }): number {
  const l = srgbToOklab(c.r, c.g, c.b);
  return Math.atan2(l.b, l.a);
}

function meanHueError(fn: (r: number, g: number, b: number) => { color: { r: number; g: number; b: number } }): number {
  let s = 0;
  for (const [r, g, b] of SATURATED) s += hueDistance(inputHue(r!, g!, b!), colorHue(fn(r!, g!, b!).color));
  return s / SATURATED.length;
}

describe("gamut-mapped (hue-penalized) matching", () => {
  it("keeps the source hue better than naive nearest on saturated inputs", () => {
    const naive = meanHueError((r, g, b) => nearestSrgb(r, g, b, pal));
    const gamut = meanHueError((r, g, b) => nearestSrgbHue(r, g, b, pal, 0.8));
    expect(gamut).toBeLessThan(naive * 0.8); // measured ~35–50% lower
  });

  it("leaves near-neutral (low-chroma) inputs unchanged — no over-desaturation risk", () => {
    for (const [r, g, b] of [[128, 128, 128], [60, 62, 64], [200, 198, 202]]) {
      const naive = nearestSrgb(r!, g!, b!, pal);
      const gamut = nearestSrgbHue(r!, g!, b!, pal, 0.8);
      expect(gamut.color.mapColorId).toBe(naive.color.mapColorId);
    }
  });

  it("matched hue for pure magenta is actually magenta-ish (not gray/blue)", () => {
    const m = nearestSrgbHue(255, 0, 255, pal, 0.8);
    // magenta-ish blocks have high red AND blue, low-ish green
    expect(m.color.r).toBeGreaterThan(100);
    expect(m.color.b).toBeGreaterThan(100);
    expect(m.color.r + m.color.b).toBeGreaterThan(m.color.g * 2);
  });
});
