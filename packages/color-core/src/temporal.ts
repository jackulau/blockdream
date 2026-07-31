import { linearRgbToOklab, srgbChannelToLinear, linearToSrgbChannel, type Lab } from "./oklab";
import { nearestByLab, nearestByLabHue, lutNearest, type PreparedPalette } from "./match";
import { quantizeFrame, type QuantizeOptions } from "./dither";
import type { RgbImage, QuantizedFrame } from "./image";

function labDist2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

/**
 * 8x8 Bayer threshold table, flattened and indexed ((y & 7) << 3) | (x & 7). It MUST hold the
 * exact doubles dither.ts's BAYER8 holds (same base integers, same `v / 64 - 0.5`
 * normalization): the hysteresis loop below reproduces quantizeBayer's candidate match
 * bit-for-bit, and the identity-to-still tests in temporal.test.ts lock the two tables
 * together. Module-local on purpose: vite-node compiles hot-loop reads of imported bindings
 * to getter calls (see the goal-087 lesson in dither.ts).
 */
const BAYER8 = (() => {
  const base = [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const out = new Float64Array(64);
  for (let i = 0; i < 64; i++) out[i] = base[i]! / 64 - 0.5;
  return out;
})();

export interface VideoQuantizeOptions extends QuantizeOptions {
  /**
   * Temporal hysteresis threshold (OKLab squared-distance units). When set > 0,
   * a pixel keeps its color from the previous frame as long as that color is
   * within `bestDist2 + temporalThreshold` of the ideal - this kills the
   * single-color flicker that makes naive per-frame quantization shimmer.
   * Applied to the "none"/"bayer" methods (error-diffusion has its own dynamics).
   * Typical values: 0.0005–0.003.
   */
  temporalThreshold?: number;
}

/**
 * Quantize a sequence of frames with optional temporal coherence.
 *
 * For temporally-stable output prefer `method: "bayer"` (deterministic per
 * position) plus a small `temporalThreshold`. Floyd–Steinberg gives the best
 * single-still quality but is the least temporally stable.
 *
 * The hysteresis path computes each pixel's CANDIDATE exactly as the
 * non-temporal `quantizeFrame` would for the method (bayer applies the
 * position's Bayer offset; `gamutMap` overrides the LUT; the LUT is honoured
 * otherwise), then applies the keep/switch decision on top. With no previous
 * frame (or a threshold that never retains) the output is element-identical to
 * per-frame `quantizeFrame`. Any method other than "bayer"/"floyd-steinberg"
 * quantizes hysteresis candidates as plain nearest ("none").
 */
export function quantizeVideo(
  frames: RgbImage[],
  pal: PreparedPalette,
  opts: VideoQuantizeOptions = {},
): QuantizedFrame[] {
  const threshold = opts.temporalThreshold ?? 0;
  const useHysteresis = threshold > 0 && opts.method !== "floyd-steinberg";
  const out: QuantizedFrame[] = [];
  let prev: QuantizedFrame | undefined;

  const isBayer = opts.method === "bayer";
  const amplitude = opts.bayerAmplitude ?? 0.06;
  const gamutMap = opts.gamutMap;
  const lut = opts.lut;

  for (const img of frames) {
    if (!useHysteresis) {
      const q = quantizeFrame(img, pal, opts);
      out.push(q);
      continue;
    }
    const { width, height } = img;
    const frame: QuantizedFrame = {
      width,
      height,
      paletteIndex: new Int32Array(width * height),
      mapColorId: new Uint8Array(width * height),
    };
    let p = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p++) {
        const i = p * 3;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        // Candidate match: EXACTLY what the non-temporal quantizer picks for this method.
        // `target` is the color the quantizer is matching (for bayer, the DITHERED color), so
        // the hysteresis distances below are measured against the same ideal the candidate was
        // chosen for.
        let target: Lab;
        let idx: number;
        if (isBayer) {
          const t = BAYER8[((y & 7) << 3) | (x & 7)]! * amplitude;
          const lr = srgbChannelToLinear(r) + t;
          const lg = srgbChannelToLinear(g) + t;
          const lb = srgbChannelToLinear(b) + t;
          target = linearRgbToOklab(lr, lg, lb);
          idx =
            gamutMap !== undefined
              ? nearestByLabHue(target, pal, gamutMap).index
              : lut
                ? lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb))
                : nearestByLab(target, pal).index;
        } else {
          target = linearRgbToOklab(srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b));
          idx =
            gamutMap !== undefined
              ? nearestByLabHue(target, pal, gamutMap).index
              : lut
                ? lutNearest(lut, r, g, b)
                : nearestByLab(target, pal).index;
        }
        const bestDist2 = labDist2(target, pal.entries[idx]!.lab);
        let chosenIdx = idx;
        if (prev) {
          const prevIdx = prev.paletteIndex[p]!;
          if (prevIdx !== chosenIdx) {
            const keepDist = labDist2(target, pal.entries[prevIdx]!.lab);
            if (keepDist <= bestDist2 + threshold) chosenIdx = prevIdx;
          }
        }
        frame.paletteIndex[p] = chosenIdx;
        frame.mapColorId[p] = pal.entries[chosenIdx]!.color.mapColorId;
      }
    }
    out.push(frame);
    prev = frame;
  }
  return out;
}
