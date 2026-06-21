import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
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

  // The match memo keys bayer by (r,g,b, x&7, y&7): an 8x8 tile repeated across a big frame
  // must produce, at every pixel, exactly the index its tile cell got — proves the memoized
  // result equals the direct per-cell match (heavy-hit path, well past the warmup window).
  it("bayer: memo is byte-identical to the per-cell match on a tiled (repeat-heavy) frame", () => {
    const tile = createRgbImage(8, 8);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) setPixel(tile, x, y, (x * 29 + 7) & 255, (y * 53 + 11) & 255, ((x + y) * 17 + 3) & 255);
    const qTile = quantizeBayer(tile, pal);
    const N = 128; // 16384 px » MEMO_WARMUP, memo stays on (each cell repeats ~256x)
    const big = createRgbImage(N, N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = ((y & 7) * 8 + (x & 7)) * 3;
        setPixel(big, x, y, tile.data[i]!, tile.data[i + 1]!, tile.data[i + 2]!);
      }
    const qBig = quantizeBayer(big, pal);
    let mismatches = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const cell = (y & 7) * 8 + (x & 7);
        if (qBig.mapColorId[y * N + x] !== qTile.mapColorId[cell]) mismatches++;
      }
    expect(mismatches).toBe(0);
  });

  // After the adaptive warmup drops the memo on a high-entropy frame, the direct fallback must
  // still return the exact match: a frame whose first rows are all-unique (forces the bail) then
  // a flat tail must quantize that tail identically to a standalone solid of the same color.
  it("nearest: the adaptive-bail direct path matches the un-bailed result", () => {
    const N = 128; // first 32 rows (=4096 px) all-unique → bail at the warmup
    const img = createRgbImage(N, N);
    for (let p = 0; p < 32 * N; p++) setPixel(img, p % N, (p / N) | 0, p & 255, (p >> 8) & 255, 0);
    for (let y = 32; y < N; y++) for (let x = 0; x < N; x++) setPixel(img, x, y, 19, 211, 97);
    const q = quantizeNearest(img, pal);
    const want = quantizeNearest(solid(2, 2, 19, 211, 97), pal).mapColorId[0];
    let mismatches = 0;
    for (let y = 40; y < N; y++) for (let x = 0; x < N; x++) if (q.mapColorId[y * N + x] !== want) mismatches++;
    expect(mismatches).toBe(0);
  });
});
