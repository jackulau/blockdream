import {
  linearRgbToOklab,
  srgbChannelToLinear,
  linearToSrgbChannel,
} from "./oklab";
import { nearestByLab, type PreparedPalette } from "./match";
import type { RgbImage, QuantizedFrame } from "./image";

export type DitherMethod = "none" | "floyd-steinberg" | "bayer";

export interface QuantizeOptions {
  method?: DitherMethod;
  /** Bayer ordered-dither amplitude in linear light (default 0.06). */
  bayerAmplitude?: number;
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

/** Match each pixel to the nearest palette color in OKLab. No dithering. */
export function quantizeNearest(img: RgbImage, pal: PreparedPalette): QuantizedFrame {
  const frame = emptyFrame(img);
  const px = img.width * img.height;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const lab = linearRgbToOklab(
      srgbChannelToLinear(img.data[i]!),
      srgbChannelToLinear(img.data[i + 1]!),
      srgbChannelToLinear(img.data[i + 2]!),
    );
    const m = nearestByLab(lab, pal);
    writePixel(frame, p, m.index, m.color.mapColorId);
  }
  return frame;
}

/**
 * Floyd–Steinberg error diffusion. Matching happens in OKLab (perceptual);
 * error is computed and diffused in LINEAR light so gamma doesn't bias it.
 * Serpentine scan reduces directional worming artifacts.
 */
export function quantizeFloydSteinberg(img: RgbImage, pal: PreparedPalette): QuantizedFrame {
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
      const m = nearestByLab(linearRgbToOklab(lr, lg, lb), pal);
      const chosen = pal.entries[m.index]!.lin;
      writePixel(frame, p, m.index, m.color.mapColorId);

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
 * Ordered (Bayer) dithering — fully deterministic per pixel position, which
 * makes it the most TEMPORALLY STABLE dither for video: a static region maps to
 * the same colors every frame, so there is no dither "crawl"/flicker.
 */
export function quantizeBayer(
  img: RgbImage,
  pal: PreparedPalette,
  amplitude = 0.06,
): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 3;
      const t = BAYER8[y & 7]![x & 7]! * amplitude;
      const lr = srgbChannelToLinear(img.data[i]!) + t;
      const lg = srgbChannelToLinear(img.data[i + 1]!) + t;
      const lb = srgbChannelToLinear(img.data[i + 2]!) + t;
      const m = nearestByLab(linearRgbToOklab(lr, lg, lb), pal);
      writePixel(frame, p, m.index, m.color.mapColorId);
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
      return quantizeNearest(img, pal);
    case "bayer":
      return quantizeBayer(img, pal, opts.bayerAmplitude);
    case "floyd-steinberg":
    default:
      return quantizeFloydSteinberg(img, pal);
  }
}

export { linearToSrgbChannel };
