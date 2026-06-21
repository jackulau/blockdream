import {
  linearRgbToOklab,
  srgbChannelToLinear,
  linearToSrgbChannel,
} from "./oklab";
import { nearestByLab, nearestByLabHue, lutNearest, type PreparedPalette, type RgbLut } from "./match";
import type { RgbImage, QuantizedFrame } from "./image";

export type DitherMethod = "none" | "floyd-steinberg" | "bayer";

// Match-memo warmup: after this many memoized pixels, if fewer than a quarter were repeats,
// the frame is too high-entropy for the cache to pay off, so we drop it and match directly for
// the rest. Purely a perf knob — both the memoized and direct paths return the same index, so
// any value here is byte-identical.
const MEMO_WARMUP = 1 << 12; // 4096 pixels

export interface QuantizeOptions {
  method?: DitherMethod;
  /** Bayer ordered-dither amplitude in linear light (default 0.06). */
  bayerAmplitude?: number;
  /** Optional prebuilt LUT (buildRgbLut) for O(1)/pixel matching - the fast path. */
  lut?: RgbLut;
  /**
   * Gamut-map by hue: when set (the hue-penalty λ, e.g. 0.8), out-of-gamut
   * saturated colors keep their hue instead of going muddy. Overrides the LUT
   * (the hue-penalized search is exact). Best for stills/hero quality.
   */
  gamutMap?: number;
  /**
   * Live-cast temporal skip: the previous frame's RGB image + its quantized result. When BOTH are
   * supplied (and dimensions match), a pixel whose input RGB equals the previous frame's at the same
   * position copies the previous palette index instead of re-running the O(palette) match. Byte-
   * identical for the position-deterministic dithers (bayer/none): the chosen index is a pure
   * function of (r,g,b,bayerCell) and the palette/amplitude/gamut are frame-constant, so the copied
   * index equals a freshly-matched one. A screencast is ~97% temporally static, so this skips nearly
   * the whole frame. Ignored by floyd-steinberg (error diffusion is not position-deterministic).
   * Absent => every pixel is matched exactly as before (all non-live callers stay byte-unchanged).
   */
  prevImage?: RgbImage;
  prevQuantized?: QuantizedFrame;
}

/** Whether a temporal skip is usable: both prev buffers present and all dimensions match `img`. */
function temporalUsable(img: RgbImage, prevImage?: RgbImage, prevQuantized?: QuantizedFrame): boolean {
  return (
    !!prevImage &&
    !!prevQuantized &&
    prevImage.width === img.width &&
    prevImage.height === img.height &&
    prevQuantized.width === img.width &&
    prevQuantized.height === img.height
  );
}

/** Nearest palette index for a linear-RGB triple - gamut-mapped, LUT (fast), or exact OKLab. */
function matchLinear(lr: number, lg: number, lb: number, pal: PreparedPalette, lut?: RgbLut, gamutMap?: number): number {
  if (gamutMap !== undefined) {
    return nearestByLabHue(linearRgbToOklab(lr, lg, lb), pal, gamutMap).index;
  }
  if (lut) {
    return lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb));
  }
  return nearestByLab(linearRgbToOklab(lr, lg, lb), pal).index;
}

/** Convert a packed sRGB image to a float linear-light working buffer (0..1). */
function toLinearBuffer(img: RgbImage): Float64Array {
  const n = img.width * img.height * 3;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = srgbChannelToLinear(img.data[i]!);
  return out;
}

function emptyFrame(img: RgbImage): QuantizedFrame {
  const px = img.width * img.height;
  return {
    width: img.width,
    height: img.height,
    paletteIndex: new Int32Array(px),
    mapColorId: new Uint8Array(px),
  };
}

function writePixel(frame: QuantizedFrame, p: number, entryIndex: number, mapColorId: number): void {
  frame.paletteIndex[p] = entryIndex;
  frame.mapColorId[p] = mapColorId;
}

/**
 * Match each pixel to the nearest palette color in OKLab. No dithering.
 * Pass a prebuilt `lut` (buildRgbLut) for O(1)/pixel matching - the fast path
 * for real-time/video; without it, exact brute-force OKLab match.
 */
export function quantizeNearest(
  img: RgbImage,
  pal: PreparedPalette,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const frame = emptyFrame(img);
  const px = img.width * img.height;
  // Temporal skip: copy the prior index where this pixel's RGB is unchanged (byte-identical, see
  // QuantizeOptions). The match is a pure function of (r,g,b), so an unchanged pixel re-matches the
  // same index. Skipped pixels never touch the memo accounting; matched pixels are unaffected.
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  // Exact memo for the brute-force path: with no LUT the match is a pure function of (r,g,b)
  // (gamutMap is frame-constant), so repeated colors reuse the result and skip the O(palette)
  // OKLab search. Byte-identical. The LUT path is already O(1)/pixel, so it skips the memo.
  const useLut = gamutMap === undefined && !!lut;
  // exact brute-force match — a pure function of (r,g,b) since gamutMap is frame-constant
  const match = (r: number, g: number, b: number): number => {
    const lab = linearRgbToOklab(srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b));
    return gamutMap === undefined ? nearestByLab(lab, pal).index : nearestByLabHue(lab, pal, gamutMap).index;
  };
  // Memo: repeated colors reuse the result and skip the O(palette) OKLab search (byte-identical).
  // Adaptive — if a warmup window shows few repeats, drop the memo so a high-entropy frame pays
  // no Map overhead. The LUT path is already O(1)/pixel and skips the memo entirely.
  const memo = useLut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
      const idx = pIdx![p]!; // re-matching would return this same index (pure function of r,g,b)
      writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
      continue;
    }
    let index: number;
    if (useLut) {
      index = lutNearest(lut!, r, g, b);
    } else if (memoOn) {
      const key = (r << 16) | (g << 8) | b;
      const hit = memo!.get(key);
      if (hit !== undefined) {
        index = hit;
        hits++;
      } else {
        index = match(r, g, b);
        memo!.set(key, index);
      }
      if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false; // <25% repeats → drop it
    } else {
      index = match(r, g, b);
    }
    writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
  }
  return frame;
}

/**
 * Floyd–Steinberg error diffusion. Matching happens in OKLab (perceptual);
 * error is computed and diffused in LINEAR light so gamma doesn't bias it.
 * Serpentine scan reduces directional worming artifacts.
 */
export function quantizeFloydSteinberg(img: RgbImage, pal: PreparedPalette, lut?: RgbLut, gamutMap?: number): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  const buf = toLinearBuffer(img); // mutated in place with diffused error

  const diffuse = (x: number, y: number, c: number, err: number, w: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    buf[(y * width + x) * 3 + c]! += err * w;
  };

  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0;
    const xStart = leftToRight ? 0 : width - 1;
    const xEnd = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += step) {
      const p = y * width + x;
      const i = p * 3;
      const lr = buf[i]!;
      const lg = buf[i + 1]!;
      const lb = buf[i + 2]!;
      const index = matchLinear(lr, lg, lb, pal, lut, gamutMap);
      const chosen = pal.entries[index]!.lin;
      writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);

      const er = lr - chosen[0];
      const eg = lg - chosen[1];
      const eb = lb - chosen[2];

      // forward neighbor is +step in x
      const fwd = step;
      diffuse(x + fwd, y, 0, er, 7 / 16);
      diffuse(x + fwd, y, 1, eg, 7 / 16);
      diffuse(x + fwd, y, 2, eb, 7 / 16);
      diffuse(x - fwd, y + 1, 0, er, 3 / 16);
      diffuse(x - fwd, y + 1, 1, eg, 3 / 16);
      diffuse(x - fwd, y + 1, 2, eb, 3 / 16);
      diffuse(x, y + 1, 0, er, 5 / 16);
      diffuse(x, y + 1, 1, eg, 5 / 16);
      diffuse(x, y + 1, 2, eb, 5 / 16);
      diffuse(x + fwd, y + 1, 0, er, 1 / 16);
      diffuse(x + fwd, y + 1, 1, eg, 1 / 16);
      diffuse(x + fwd, y + 1, 2, eb, 1 / 16);
    }
  }
  return frame;
}

// 8×8 Bayer ordered-dither matrix, normalized to (-0.5 .. +0.5).
const BAYER8 = (() => {
  const base = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  return base.map((row) => row.map((v) => v / 64 - 0.5));
})();

/**
 * Ordered (Bayer) dithering - fully deterministic per pixel position, which
 * makes it the most TEMPORALLY STABLE dither for video: a static region maps to
 * the same colors every frame, so there is no dither "crawl"/flicker.
 */
export function quantizeBayer(
  img: RgbImage,
  pal: PreparedPalette,
  amplitude = 0.06,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  // Temporal skip: copy the prior index where this pixel's RGB is unchanged (byte-identical, see
  // QuantizeOptions). bayer is position-deterministic, so an unchanged pixel at the same (x,y) cell
  // re-matches the same index. Skipped pixels never touch the memo accounting.
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  // Exact memo: bayer is position-deterministic, so the match is a pure function of
  // (r, g, b, bayerCell) (amplitude/gamutMap are frame-constant). Real frames repeat colors
  // within each of the 64 cells → skip the O(palette) match on repeats. Byte-identical.
  // Adaptive — drop the memo after a warmup window that shows few repeats so a high-entropy
  // frame pays no Map overhead. The LUT path is already O(1)/pixel, so it skips the memo.
  const memo = lut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 3;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
        const idx = pIdx![p]!; // re-matching would return this same index (pure fn of r,g,b,cell)
        writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
        continue;
      }
      let index: number;
      if (memoOn) {
        const key = ((r << 16) | (g << 8) | b) * 64 + ((y & 7) << 3) + (x & 7);
        const hit = memo!.get(key);
        if (hit !== undefined) {
          index = hit;
          hits++;
        } else {
          const t = BAYER8[y & 7]![x & 7]! * amplitude;
          index = matchLinear(srgbChannelToLinear(r) + t, srgbChannelToLinear(g) + t, srgbChannelToLinear(b) + t, pal, lut, gamutMap);
          memo!.set(key, index);
        }
        if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false; // <25% repeats → drop it
      } else {
        const t = BAYER8[y & 7]![x & 7]! * amplitude;
        index = matchLinear(
          srgbChannelToLinear(r) + t,
          srgbChannelToLinear(g) + t,
          srgbChannelToLinear(b) + t,
          pal,
          lut,
          gamutMap,
        );
      }
      writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
    }
  }
  return frame;
}

export function quantizeFrame(
  img: RgbImage,
  pal: PreparedPalette,
  opts: QuantizeOptions = {},
): QuantizedFrame {
  switch (opts.method ?? "floyd-steinberg") {
    case "none":
      // position-deterministic → temporal skip is byte-identical (prev threaded through)
      return quantizeNearest(img, pal, opts.lut, opts.gamutMap, opts.prevImage, opts.prevQuantized);
    case "bayer":
      // position-deterministic → temporal skip is byte-identical (prev threaded through)
      return quantizeBayer(img, pal, opts.bayerAmplitude, opts.lut, opts.gamutMap, opts.prevImage, opts.prevQuantized);
    case "floyd-steinberg":
    default:
      // error diffusion is NOT position-deterministic — a pixel depends on its neighbours' diffused
      // error, so a temporal skip would corrupt it. Always full-quantize (prev intentionally ignored).
      return quantizeFloydSteinberg(img, pal, opts.lut, opts.gamutMap);
  }
}

export { linearToSrgbChannel };
