import { linearRgbToOklab, srgbChannelToLinear, linearToSrgbChannel, type Lab } from "./oklab";
import { nearestByLab, nearestByLabHue, lutNearest, type PreparedPalette } from "./match";
import { quantizeFrame, quantizeFrameHysteresis, type QuantizeOptions } from "./dither";
import type { RgbImage, QuantizedFrame } from "./image";

function labDist2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

/**
 * 8x8 Bayer threshold table for the REFERENCE twin below, flattened and indexed
 * ((y & 7) << 3) | (x & 7). It MUST hold the exact doubles dither.ts's BAYER8 holds (same base
 * integers, same `v / 64 - 0.5` normalization); the identity-to-still tests in temporal.test.ts
 * lock the two tables together.
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
 * quantizes hysteresis candidates as plain nearest ("none"). An omitted
 * `method` means floyd-steinberg, exactly as `quantizeFrame` documents - so
 * no-method + temporalThreshold takes the per-frame floyd path (hysteresis
 * never applies to error diffusion) rather than silently downgrading to
 * plain-nearest hysteresis, a default the still and video quantizers used to
 * disagree on. The per-frame hot loop is quantizeFrameHysteresis in dither.ts
 * (allocation-free; element-identical to quantizeVideoReference, locked by
 * dither-perf.test.ts).
 */
export function quantizeVideo(
  frames: RgbImage[],
  pal: PreparedPalette,
  opts: VideoQuantizeOptions = {},
): QuantizedFrame[] {
  const threshold = opts.temporalThreshold ?? 0;
  const useHysteresis = threshold > 0 && (opts.method ?? "floyd-steinberg") !== "floyd-steinberg";
  const out: QuantizedFrame[] = [];
  let prev: QuantizedFrame | undefined;

  for (const img of frames) {
    if (!useHysteresis) {
      out.push(quantizeFrame(img, pal, opts));
      continue;
    }
    const frame = quantizeFrameHysteresis(img, pal, opts, threshold, prev);
    out.push(frame);
    prev = frame;
  }
  return out;
}

/**
 * Reference video quantizer, kept verbatim from before the hysteresis hot loop moved to
 * dither.ts's allocation-free quantizeFrameHysteresis: per-pixel {L,a,b}/{index,color,dist2}
 * allocations via the public matchers, entry-object chains for the hysteresis distances.
 * Exported only for the same-run opt-vs-ref A/B in dither-perf.test.ts. Do not optimize.
 */
export function quantizeVideoReference(
  frames: RgbImage[],
  pal: PreparedPalette,
  opts: VideoQuantizeOptions = {},
): QuantizedFrame[] {
  const threshold = opts.temporalThreshold ?? 0;
  // same no-method default as quantizeVideo (the twins must stay element-identical)
  const useHysteresis = threshold > 0 && (opts.method ?? "floyd-steinberg") !== "floyd-steinberg";
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
