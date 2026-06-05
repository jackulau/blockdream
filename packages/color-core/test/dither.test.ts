import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette } from "../src/match";
import { quantizeFloydSteinberg, quantizeBayer, quantizeNearest } from "../src/dither";
import { createRgbImage, setPixel, type RgbImage } from "../src/image";

const pal = preparePalette(getJavaMapPalette());

function solid(w: number, h: number, r: number, g: number, b: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, r, g, b);
  return img;
}

describe("quantizers", () => {
  it("nearest: a solid exact-palette color maps every pixel to that id", () => {
    const img = solid(16, 16, 127, 178, 56); // mapColorId 6
    const q = quantizeNearest(img, pal);
    expect(q.paletteIndex.length).toBe(256);
    expect([...q.mapColorId].every((v) => v === 6)).toBe(true);
  });

  it("floyd-steinberg: a solid exact-palette color stays that color (zero error)", () => {
    const img = solid(16, 16, 127, 178, 56);
    const q = quantizeFloydSteinberg(img, pal);
    expect([...q.mapColorId].every((v) => v === 6)).toBe(true);
  });

  it("floyd-steinberg: a black→white gradient spans many palette colors", () => {
    // a left-to-right luminance ramp cannot be represented by one color
    const w = 64;
    const img = createRgbImage(w, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.round((x / (w - 1)) * 255);
        setPixel(img, x, y, v, v, v);
      }
    }
    const q = quantizeFloydSteinberg(img, pal);
    const distinct = new Set(q.mapColorId);
    expect(distinct.size).toBeGreaterThan(4);
  });

  it("bayer: output dimensions and id ranges are valid", () => {
    const img = solid(24, 24, 200, 50, 120);
    const q = quantizeBayer(img, pal);
    expect(q.width).toBe(24);
    expect(q.height).toBe(24);
    expect([...q.mapColorId].every((v) => v >= 4 && v <= 247)).toBe(true);
  });
});
