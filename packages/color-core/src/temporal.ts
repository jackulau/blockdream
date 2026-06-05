import { linearRgbToOklab, srgbChannelToLinear, type Lab } from "./oklab";
import { nearestByLab, lutNearest, type PreparedPalette } from "./match";
import { quantizeFrame, type QuantizeOptions } from "./dither";
import type { RgbImage, QuantizedFrame } from "./image";

function labDist2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

export interface VideoQuantizeOptions extends QuantizeOptions {
  /**
   * Temporal hysteresis threshold (OKLab squared-distance units). When set > 0,
   * a pixel keeps its color from the previous frame as long as that color is
   * within `bestDist2 + temporalThreshold` of the ideal — this kills the
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

  for (const img of frames) {
    if (!useHysteresis) {
      const q = quantizeFrame(img, pal, opts);
      out.push(q);
      continue;
    }
    const px = img.width * img.height;
    const frame: QuantizedFrame = {
      width: img.width,
      height: img.height,
      paletteIndex: new Int32Array(px),
      mapColorId: new Uint8Array(px),
    };
    for (let p = 0; p < px; p++) {
      const i = p * 3;
      const target = linearRgbToOklab(
        srgbChannelToLinear(img.data[i]!),
        srgbChannelToLinear(img.data[i + 1]!),
        srgbChannelToLinear(img.data[i + 2]!),
      );
      // fast path: LUT picks the index, then dist2 is one labDist2 (not 244)
      const idx = opts.lut ? lutNearest(opts.lut, img.data[i]!, img.data[i + 1]!, img.data[i + 2]!) : nearestByLab(target, pal).index;
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
    out.push(frame);
    prev = frame;
  }
  return out;
}
