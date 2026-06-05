import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette } from "../src/match";
import { createRgbImage, setPixel, type RgbImage } from "../src/image";
import { oklabDeltaE, meanMatchError, blockAverageError, qualityReport } from "../src/quality";
import { quantizeFrame } from "../src/dither";

const pal = preparePalette(getJavaMapPalette());

function photoLike(W: number, H: number): RgbImage {
  const img = createRgbImage(W, H);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      setPixel(
        img,
        x,
        y,
        clamp(128 + 100 * Math.sin(x / 18) * Math.cos(y / 25)),
        clamp(128 + 100 * Math.sin(y / 15 + 1)),
        clamp(128 + 100 * Math.cos(x / 22 + y / 30)),
      );
    }
  }
  return img;
}

function grayGradient(W: number, H: number): RgbImage {
  const img = createRgbImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.round((x / (W - 1)) * 255);
    setPixel(img, x, y, v, v, v);
  }
  return img;
}

describe("renderer quality", () => {
  it("ΔE is 0 for identical colors and positive otherwise", () => {
    expect(oklabDeltaE(10, 20, 30, 10, 20, 30)).toBeCloseTo(0, 9);
    expect(oklabDeltaE(0, 0, 0, 255, 255, 255)).toBeGreaterThan(0.5);
  });

  it("palette represents photo-like content with low mean ΔE", () => {
    const err = meanMatchError(photoLike(96, 96), pal);
    expect(err).toBeLessThan(0.06); // measured ~0.040
  });

  it("Floyd–Steinberg dithering greatly reduces block-average tone error (anti-banding)", () => {
    const img = grayGradient(96, 96);
    const fNone = quantizeFrame(img, pal, { method: "none" });
    const fFs = quantizeFrame(img, pal, { method: "floyd-steinberg" });
    const eNone = blockAverageError(img, fNone, pal, 8);
    const eFs = blockAverageError(img, fFs, pal, 8);
    expect(eFs).toBeLessThan(eNone * 0.5); // measured ~6× better
  });

  it("dithering uses at least as many palette colors as nearest", () => {
    const img = grayGradient(96, 96);
    const qNone = qualityReport(img, pal, "none");
    const qFs = qualityReport(img, pal, "floyd-steinberg");
    expect(qFs.distinctColors).toBeGreaterThanOrEqual(qNone.distinctColors);
  });
});
