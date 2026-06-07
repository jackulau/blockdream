import { srgbChannelToLinear, linearToSrgbChannel, type RgbImage } from "@blockdream/color-core";

/**
 * Box-average downscale in LINEAR light (the correct space for averaging colors).
 * ffmpeg's `scale=...:flags=area` averages in gamma space; for best fidelity,
 * decode at a larger size and downsample with this. Pure box filter (no overlap
 * weighting) — adequate for integer-ish ratios and the small target grids here.
 */
export function resizeAreaLinear(src: RgbImage, dstW: number, dstH: number): RgbImage {
  if (dstW <= 0 || dstH <= 0) throw new Error("target size must be > 0");
  const out = new Uint8Array(dstW * dstH * 3);
  const sx = src.width / dstW;
  const sy = src.height / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * sy));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < src.height; y++) {
        for (let x = x0; x < x1 && x < src.width; x++) {
          const i = (y * src.width + x) * 3;
          r += srgbChannelToLinear(src.data[i]!);
          g += srgbChannelToLinear(src.data[i + 1]!);
          b += srgbChannelToLinear(src.data[i + 2]!);
          n++;
        }
      }
      const o = (dy * dstW + dx) * 3;
      out[o] = linearToSrgbChannel(r / n);
      out[o + 1] = linearToSrgbChannel(g / n);
      out[o + 2] = linearToSrgbChannel(b / n);
    }
  }
  return { width: dstW, height: dstH, data: out };
}
