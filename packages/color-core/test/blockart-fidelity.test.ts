// Block-art fidelity: mapping real Minecraft-style pixel art to the 244-color map
// palette must be COLOR-FAITHFUL — every cell's chosen block color should be close to
// the source pixel (small ΔE2000), and the chosen-block count should be sane.

import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette } from "../src/match";
import { quantizeFrame } from "../src/dither";
import { createRgbImage, setPixel, type RgbImage } from "../src/image";
import { deltaE2000Srgb } from "../src/ciede2000";

const pal = preparePalette(getJavaMapPalette());

// a recognizable Minecraft scene: sky, grass, dirt, stone, oak trunk + leaves
function pixelArtScene(W = 64, H = 64): RgbImage {
  const img = createRgbImage(W, H);
  const SKY = [135, 206, 235];
  const GRASS = [95, 159, 53];
  const DIRT = [134, 96, 67];
  const STONE = [127, 127, 127];
  const TRUNK = [102, 76, 51];
  const LEAF = [60, 120, 40];
  const put = (x: number, y: number, c: number[]) => {
    if (x >= 0 && x < W && y >= 0 && y < H) setPixel(img, x, y, c[0]!, c[1]!, c[2]!);
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const band = y < 38 ? SKY : y < 42 ? GRASS : y < 54 ? DIRT : STONE;
      put(x, y, band);
    }
  for (let y = 26; y < 42; y++) for (let x = 30; x < 34; x++) put(x, y, TRUNK);
  for (let y = 14; y < 30; y++)
    for (let x = 22; x < 42; x++) if ((x - 32) ** 2 + (y - 22) ** 2 < 90) put(x, y, LEAF);
  return img;
}

function fidelity(method: "none" | "floyd-steinberg" | "bayer") {
  const img = pixelArtScene();
  const q = quantizeFrame(img, pal, { method });
  const px = q.width * q.height;
  const errs: number[] = [];
  const bases = new Set<number>();
  for (let p = 0; p < px; p++) {
    const sr = img.data[p * 3]!, sg = img.data[p * 3 + 1]!, sb = img.data[p * 3 + 2]!;
    const chosen = pal.entries[q.paletteIndex[p]!]!.color;
    errs.push(deltaE2000Srgb(sr, sg, sb, chosen.r, chosen.g, chosen.b));
    bases.add(chosen.baseId);
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((s, e) => s + e, 0) / px;
  const p95 = errs[Math.floor(px * 0.95)]!;
  return { mean, p95, max: errs[px - 1]!, distinctBlocks: bases.size, q };
}

describe("block-art fidelity vs real pixel art", () => {
  it("nearest-match is color-faithful per cell (in-family ΔE2000 on a 244-colour palette)", () => {
    const f = fidelity("none");
    // eslint-disable-next-line no-console
    console.log(`\n[block-art ΔE2000] nearest: mean ${f.mean.toFixed(2)} p95 ${f.p95.toFixed(2)} max ${f.max.toFixed(2)} · ${f.distinctBlocks} blocks`);
    // The matcher is near-CIEDE2000-optimal (see ciede2000.test); ~9 mean is the honest
    // ceiling of a 244-colour palette on saturated content — same colour family, no wild misses.
    expect(f.mean).toBeLessThan(12);
    expect(f.p95).toBeLessThan(20);
    expect(f.max).toBeLessThan(25); // even the single worst cell isn't a different colour
  });

  it("uses a sane number of distinct blocks and every cell resolves to a real block", () => {
    const f = fidelity("none");
    expect(f.distinctBlocks).toBeGreaterThanOrEqual(4); // sky/grass/dirt/stone/trunk/leaf
    expect(f.distinctBlocks).toBeLessThan(30); // not exploding into colour noise
    for (let p = 0; p < f.q.width * f.q.height; p++) {
      const baseId = pal.entries[f.q.paletteIndex[p]!]!.color.baseId;
      expect(baseId).toBeGreaterThanOrEqual(1); // a valid Minecraft block base (1..61)
      expect(baseId).toBeLessThanOrEqual(64);
    }
  });

  it("dithering preserves the overall average colour (error diffusion)", () => {
    // dithering's promise: the whole-image AVERAGE colour stays true to the source
    const img = pixelArtScene();
    const q = quantizeFrame(img, pal, { method: "floyd-steinberg" });
    const px = q.width * q.height;
    let sr = 0, sg = 0, sb = 0, cr = 0, cg = 0, cb = 0;
    for (let p = 0; p < px; p++) {
      sr += img.data[p * 3]!; sg += img.data[p * 3 + 1]!; sb += img.data[p * 3 + 2]!;
      const c = pal.entries[q.paletteIndex[p]!]!.color;
      cr += c.r; cg += c.g; cb += c.b;
    }
    const globalDe = deltaE2000Srgb(sr / px, sg / px, sb / px, cr / px, cg / px, cb / px);
    // eslint-disable-next-line no-console
    console.log(`[block-art ΔE2000] dither whole-image mean ΔE ${globalDe.toFixed(2)}`);
    expect(globalDe).toBeLessThan(5);
  });
});
