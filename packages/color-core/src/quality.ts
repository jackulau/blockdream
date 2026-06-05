import { srgbToOklab, srgbChannelToLinear } from "./oklab";
import { quantizeFrame, type DitherMethod } from "./dither";
import type { PreparedPalette } from "./match";
import { nearestByLab } from "./match";
import type { RgbImage, QuantizedFrame } from "./image";

/** Perceptual color difference (euclidean distance in OKLab) between two 8-bit colors. */
export function oklabDeltaE(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const a = srgbToOklab(r1, g1, b1);
  const b = srgbToOklab(r2, g2, b2);
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Mean OKLab ΔE between each source pixel and its NEAREST palette color.
 * Pure measure of palette coverage (no dithering) — lower = the palette can
 * represent this content well.
 */
export function meanMatchError(img: RgbImage, pal: PreparedPalette): number {
  let sum = 0;
  const px = img.width * img.height;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const m = nearestByLab(srgbToOklab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!), pal);
    sum += Math.sqrt(m.dist2);
  }
  return sum / px;
}

/** Per-pixel chosen palette color of a quantized frame, in linear-light RGB. */
function reconstructLinear(frame: QuantizedFrame, pal: PreparedPalette): Float64Array {
  const px = frame.width * frame.height;
  const out = new Float64Array(px * 3);
  for (let p = 0; p < px; p++) {
    const lin = pal.entries[frame.paletteIndex[p]!]!.lin;
    out[p * 3] = lin[0];
    out[p * 3 + 1] = lin[1];
    out[p * 3 + 2] = lin[2];
  }
  return out;
}

/**
 * Tone-fidelity error: average a `block`×`block` neighborhood of both the source
 * and the rendered result in LINEAR light, then measure the mean error between
 * those averages. Dithering trades per-pixel exactness for correct LOCAL AVERAGE
 * tone, so a good dither has LOWER block-average error than nearest — this is the
 * quantitative proof that dithering reduces banding.
 */
export function blockAverageError(
  img: RgbImage,
  frame: QuantizedFrame,
  pal: PreparedPalette,
  block = 8,
): number {
  const recon = reconstructLinear(frame, pal);
  const { width: W, height: H } = img;
  let sum = 0;
  let n = 0;
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      let sr = 0, sg = 0, sb = 0, rr = 0, rg = 0, rb = 0, cnt = 0;
      for (let y = by; y < Math.min(by + block, H); y++) {
        for (let x = bx; x < Math.min(bx + block, W); x++) {
          const p = y * W + x;
          const i = p * 3;
          sr += srgbChannelToLinear(img.data[i]!);
          sg += srgbChannelToLinear(img.data[i + 1]!);
          sb += srgbChannelToLinear(img.data[i + 2]!);
          rr += recon[i]!;
          rg += recon[i + 1]!;
          rb += recon[i + 2]!;
          cnt++;
        }
      }
      const dr = sr / cnt - rr / cnt;
      const dg = sg / cnt - rg / cnt;
      const dbl = sb / cnt - rb / cnt;
      sum += Math.sqrt(dr * dr + dg * dg + dbl * dbl);
      n++;
    }
  }
  return sum / n;
}

export interface QualityReport {
  method: DitherMethod;
  meanMatchError: number;
  blockAverageError: number;
  distinctColors: number;
}

/** Full quality report for a rendered image under a given dither method. */
export function qualityReport(img: RgbImage, pal: PreparedPalette, method: DitherMethod, block = 8): QualityReport {
  const frame = quantizeFrame(img, pal, { method });
  return {
    method,
    meanMatchError: meanMatchError(img, pal),
    blockAverageError: blockAverageError(img, frame, pal, block),
    distinctColors: new Set(frame.mapColorId).size,
  };
}
