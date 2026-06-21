import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette } from "../src/match";
import { quantizeFloydSteinberg, quantizeBayer, quantizeNearest, quantizeFrame } from "../src/dither";
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

// Live-cast temporal skip: when the previous frame's RGB + quantized result are supplied, a pixel
// whose RGB is unchanged copies the prior palette index instead of re-matching. Must be byte-
// identical to a full quantize (the index is a pure function of the pixel for bayer/nearest), and
// floyd-steinberg must ignore the prev (error diffusion is not position-deterministic).
describe("temporal-skip quantize (live screencast cast)", () => {
  const N = 48;
  function detailed(): RgbImage {
    // high-detail content so the intra-frame memo can't mask a broken temporal copy
    const img = createRgbImage(N, N);
    for (let p = 0; p < N * N; p++) setPixel(img, p % N, (p / N) | 0, (p * 7) & 255, (p * 13) & 255, (p * 5) & 255);
    return img;
  }
  function changedFrom(base: RgbImage): RgbImage {
    const cur = createRgbImage(N, N);
    cur.data.set(base.data);
    for (let y = 5; y < 20; y++) for (let x = 5; x < 20; x++) setPixel(cur, x, y, (x * 17) & 255, (y * 19) & 255, 200);
    return cur;
  }

  it("bayer: temporal-skip output is byte-identical to a full quantize on a mixed frame", () => {
    const prev = detailed();
    const cur = changedFrom(prev);
    const prevQ = quantizeBayer(prev, pal);
    const full = quantizeBayer(cur, pal);
    const temporal = quantizeBayer(cur, pal, 0.06, undefined, undefined, prev, prevQ);
    expect([...temporal.paletteIndex]).toEqual([...full.paletteIndex]);
    expect([...temporal.mapColorId]).toEqual([...full.mapColorId]);
  });

  it("nearest: temporal-skip output is byte-identical to a full quantize on a mixed frame", () => {
    const prev = detailed();
    const cur = changedFrom(prev);
    const prevQ = quantizeNearest(prev, pal);
    const full = quantizeNearest(cur, pal);
    const temporal = quantizeNearest(cur, pal, undefined, undefined, prev, prevQ);
    expect([...temporal.paletteIndex]).toEqual([...full.paletteIndex]);
    expect([...temporal.mapColorId]).toEqual([...full.mapColorId]);
  });

  it("quantizeFrame bayer threads prev through and stays byte-identical", () => {
    const prev = detailed();
    const cur = changedFrom(prev);
    const prevQ = quantizeFrame(prev, pal, { method: "bayer" });
    const full = quantizeFrame(cur, pal, { method: "bayer" });
    const temporal = quantizeFrame(cur, pal, { method: "bayer", prevImage: prev, prevQuantized: prevQ });
    expect([...temporal.paletteIndex]).toEqual([...full.paletteIndex]);
  });

  // load-bearing: the skip path is actually taken — a tampered prior index propagates verbatim for an
  // unchanged pixel (proves we copy, not re-match), and the byte-identity above depends on prevQ being
  // the real quantize of prevFrame (which the live loop guarantees).
  it("copies the prior index verbatim for an unchanged pixel (skip path is exercised)", () => {
    const prev = detailed();
    const prevQ = quantizeBayer(prev, pal);
    const tampered = {
      width: prevQ.width,
      height: prevQ.height,
      paletteIndex: Int32Array.from(prevQ.paletteIndex),
      mapColorId: Uint8Array.from(prevQ.mapColorId),
    };
    const wrong = (prevQ.paletteIndex[0]! + 1) % pal.entries.length;
    tampered.paletteIndex[0] = wrong;
    tampered.mapColorId[0] = pal.entries[wrong]!.color.mapColorId;
    // cur === prev (every pixel unchanged) → every pixel must be copied from `tampered`
    const out = quantizeBayer(prev, pal, 0.06, undefined, undefined, prev, tampered);
    expect(out.paletteIndex[0]).toBe(wrong);
    expect([...out.paletteIndex]).toEqual([...tampered.paletteIndex]);
  });

  it("floyd-steinberg IGNORES prev (error diffusion is not position-deterministic)", () => {
    const prev = detailed();
    const cur = changedFrom(prev);
    const prevQ = quantizeFrame(prev, pal, { method: "floyd-steinberg" });
    const noPrev = quantizeFrame(cur, pal, { method: "floyd-steinberg" });
    const withPrev = quantizeFrame(cur, pal, { method: "floyd-steinberg", prevImage: prev, prevQuantized: prevQ });
    expect([...withPrev.paletteIndex]).toEqual([...noPrev.paletteIndex]);
  });
});
