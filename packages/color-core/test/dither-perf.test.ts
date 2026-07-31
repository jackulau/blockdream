import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, buildRgbLut, type PreparedPalette, type RgbLut } from "../src/match";
import { quantizeFloydSteinberg, quantizeFloydSteinbergReference } from "../src/dither";
import { createRgbImage, setPixel, type RgbImage, type QuantizedFrame } from "../src/image";

const pal = preparePalette(getJavaMapPalette());
const lut = buildRgbLut(pal, 33);

// Smooth 2D gradient: the classic error-diffusion input (long runs of slowly-drifting error,
// so any single float divergence cascades visibly for the rest of the frame).
function gradient(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = w > 1 ? Math.round((x / (w - 1)) * 255) : 128;
      const g = h > 1 ? Math.round((y / (h - 1)) * 255) : 128;
      const b = Math.round((((x + y) % (w + h)) / (w + h - 1 || 1)) * 255);
      setPixel(img, x, y, r, g, b);
    }
  return img;
}

// Photo-like noise via a deterministic LCG (high-entropy, exercises the whole palette and the
// full spread of diffused-error magnitudes).
function noise(w: number, h: number, seed = 12345): RgbImage {
  const img = createRgbImage(w, h);
  let s = seed;
  for (let i = 0; i < img.data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    img.data[i] = (s >> 8) & 255;
  }
  return img;
}

// Hard edges: 8px blocks of saturated colors. Error spikes at every block boundary, the case
// where a diffusion-order or bounds-flag mistake would show up first.
function hardEdges(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  const colors: Array<[number, number, number]> = [
    [255, 0, 0],
    [255, 255, 255],
    [0, 0, 255],
    [0, 0, 0],
    [0, 255, 0],
    [255, 0, 255],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = colors[(((x >> 3) + (y >> 3)) % colors.length + colors.length) % colors.length]!;
      setPixel(img, x, y, c[0], c[1], c[2]);
    }
  return img;
}

// Photo-like 256x256: smooth gradient base + LCG grain, the shape of a real imported still on
// the hero web path (QUANT3D_STILL is floyd-steinberg + gamutMap).
function photoLike(n: number): RgbImage {
  const img = gradient(n, n);
  let s = 0xbadc0de;
  for (let i = 0; i < img.data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const grain = ((s >> 8) & 63) - 32;
    const v = img.data[i]! + grain;
    img.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return img;
}

/** Element-exact frame comparison: paletteIndex, mapColorId, AND the palette RGB each maps to. */
function expectByteIdentical(opt: QuantizedFrame, ref: QuantizedFrame, p: PreparedPalette): void {
  expect(opt.width).toBe(ref.width);
  expect(opt.height).toBe(ref.height);
  expect(opt.paletteIndex.length).toBe(ref.paletteIndex.length);
  expect(opt.mapColorId.length).toBe(ref.mapColorId.length);
  let mismatches = 0;
  for (let i = 0; i < ref.paletteIndex.length; i++) {
    const a = opt.paletteIndex[i]!;
    const b = ref.paletteIndex[i]!;
    const ca = p.entries[a]!.color;
    const cb = p.entries[b]!.color;
    if (
      a !== b ||
      opt.mapColorId[i] !== ref.mapColorId[i] ||
      ca.r !== cb.r ||
      ca.g !== cb.g ||
      ca.b !== cb.b
    ) {
      mismatches++;
    }
  }
  expect(mismatches).toBe(0);
}

describe("quantizeFloydSteinberg (de-closured diffusion + allocation-free match)", () => {
  // FS error diffusion cascades: one wrong float anywhere corrupts the rest of the frame, so
  // each case is a whole-frame element-exact lock, across all three match paths (gamutMap,
  // exact OKLab, LUT). The serpentine scan has no on/off switch: every image with height >= 2
  // exercises both scan directions; 17x1 pins the single-row (forward-only) shape.
  const cases: Array<[string, RgbImage, RgbLut | undefined, number | undefined]> = [
    ["256x256 gradient, gamutMap 0.8 (hero still path)", gradient(256, 256), undefined, 0.8],
    ["256x256 gradient, exact OKLab", gradient(256, 256), undefined, undefined],
    ["photo-like noise 97x64, gamutMap 0.8", noise(97, 64), undefined, 0.8],
    ["photo-like noise 97x64, exact OKLab", noise(97, 64), undefined, undefined],
    ["hard edges 64x64, gamutMap 0.8", hardEdges(64, 64), undefined, 0.8],
    ["hard edges 64x64, exact OKLab", hardEdges(64, 64), undefined, undefined],
    ["LUT path, noise 64x64", noise(64, 64, 777), lut, undefined],
    ["LUT present but overridden by gamutMap, noise 64x64", noise(64, 64, 777), lut, 0.8],
    ["1x1, gamutMap 0.8", noise(1, 1), undefined, 0.8],
    ["1x1, exact OKLab", noise(1, 1), undefined, undefined],
    ["3x5, gamutMap 0.8", gradient(3, 5), undefined, 0.8],
    ["3x5, exact OKLab", noise(3, 5, 999), undefined, undefined],
    ["17x1 single row, gamutMap 0.8", gradient(17, 1), undefined, 0.8],
    ["17x1 single row, exact OKLab", gradient(17, 1), undefined, undefined],
    ["photo-like 256x256, gamutMap 0.8", photoLike(256), undefined, 0.8],
  ];

  for (const [name, img, l, gamutMap] of cases) {
    it(`is byte-identical to the reference: ${name}`, () => {
      const opt = quantizeFloydSteinberg(img, pal, l, gamutMap);
      const ref = quantizeFloydSteinbergReference(img, pal, l, gamutMap);
      expectByteIdentical(opt, ref, pal);
    });
  }

  // Same-run interleaved A/B (same style as rgbscreen-perf.test.ts): both quantizers run
  // back-to-back in this process on the same 256x256 photo-like frame with gamutMap 0.8, the
  // measured hero-path shape (61.6ms/frame reference, a visible stall at 512px). 12 rounds with
  // the ref/opt ORDER alternating each round: whoever runs second inherits the first's GC debt,
  // so a fixed order systematically biases the comparison; alternation cancels that. Compare
  // MEDIANS: a major GC or an OS scheduling spike lands in one arbitrary round, which poisons a
  // sum and can even poison a min, while the median ignores it on either side. retry: a timing
  // inversion needs a sustained hostile phase across EVERY attempt to produce a false failure,
  // while a genuine regression loses all attempts in any environment.
  it("floyd-steinberg is byte-identical to the reference AND >=1.15x faster at 256x256 (same-run interleaved timing)", { retry: 2, timeout: 120000 }, () => {
    const img = photoLike(256);
    const gamutMap = 0.8;
    const runRef = () => quantizeFloydSteinbergReference(img, pal, undefined, gamutMap);
    const runOpt = () => quantizeFloydSteinberg(img, pal, undefined, gamutMap);
    // byte identity on the timed input, and warmup for the JIT
    expectByteIdentical(runOpt(), runRef(), pal);
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    for (let iter = 0; iter < 12; iter++) {
      if (iter % 2 === 0) {
        refTimes.push(timed(runRef));
        optTimes.push(timed(runOpt));
      } else {
        optTimes.push(timed(runOpt));
        refTimes.push(timed(runRef));
      }
    }
    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
    };
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // measured ~1.7x locally; assert a conservative floor so a busy CI box cannot flake the gate
    expect(refMs / optMs).toBeGreaterThanOrEqual(1.15);
  });
});
