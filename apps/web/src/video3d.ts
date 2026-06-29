// Browser glue for "import an animation video → animated 3D blocks". The temporally-stable
// frame→solid conversion is the pure framesToAnimated3d in @blockdream/voxel (shared with the CLI);
// here we add the browser-side decode + quantize step. Each decoded RGB frame is matched to the 3D
// block palette through the SAME color-core quantizer the 2D pixel-art path uses (configurable
// dither + gamut mapping), then turned into a real subject-isolated solid (NOT a flat slab).

import { framesToAnimated3d, framesToFlat3d, type Video3dOptions, type VoxelVolume } from "@blockdream/voxel";
import { quantizeFrame, type QuantizeOptions, type RgbImage } from "@blockdream/color-core";

export { framesToAnimated3d, framesToFlat3d };
export type { Video3dOptions };

type Palette = Parameters<typeof quantizeFrame>[1];

/** Quantize a sequence of decoded RGB frames to the block palette, then voxelize them into a
 *  temporally-coherent 3D block animation. `quantize` defaults to gamut-mapped nearest matching -
 *  per-frame error-diffusion dither would speckle differently frame-to-frame and defeat the
 *  temporal stabilizer; stills that want dither pass it explicitly. */
export function rgbFramesToAnimated3d(
  frames: RgbImage[],
  palette: Palette,
  opts: Video3dOptions & { quantize?: QuantizeOptions } = {},
): VoxelVolume[] {
  const { quantize, ...video3d } = opts;
  const quantized = frames.map((f) => quantizeFrame(f, palette, quantize ?? { method: "none", gamutMap: 0.8 }));
  // shape-from-shading on by default: per-pixel OKLab lightness of the matched block carves internal
  // relief into each frame's dome. Caller can override shadingForFrame or set shadingGain: 0 to disable.
  const shadingGain = video3d.shadingGain ?? 0.5;
  const shadingForFrame =
    video3d.shadingForFrame ??
    (shadingGain > 0
      ? (f: number, x: number, y: number) => palette.entries[quantized[f]!.paletteIndex[y * quantized[f]!.width + x]!]!.lab.L
      : undefined);
  return framesToAnimated3d(quantized, { ...video3d, shadingGain, shadingForFrame });
}

/** Quantize a sequence of decoded RGB frames to the block palette, then voxelize them FLAT — the
 *  parity path for 2D motion-graphic GIFs/videos. Unlike rgbFramesToAnimated3d this does NOT isolate a
 *  subject or inflate a dome: the front face of each thin slab is the source frame, block-for-block, so
 *  playback reproduces the original animation instead of a boiling blob. `isAirForFrame` (from the
 *  decoded canvas alpha) maps transparent pixels to air so a transparent GIF floats; an opaque clip
 *  becomes the full rectangle.
 *
 *  Quantizer defaults to BAYER ordered dither (not flat nearest). The block palette is only ~60 colours,
 *  so a flat nearest match bands smooth shading into ugly steps; bayer dithers between the two nearest
 *  palette colours to approximate the true colour, which is what makes playback actually resemble the
 *  source. Crucially bayer is POSITION-deterministic (threshold is a pure function of the (x,y) cell), so
 *  a pixel whose colour is unchanged frame-to-frame quantizes to the SAME block every frame — no temporal
 *  shimmer, no boiling. (Error-diffusion would shimmer, which is why the dome path avoided dither; the
 *  flat path has no such constraint.) A low amplitude keeps genuinely-flat regions mapping to a single
 *  colour so greedy meshing still merges them — only gradients/edges dither. */
export function rgbFramesToFlat3d(
  frames: RgbImage[],
  palette: Palette,
  opts: { depth?: number; quantize?: QuantizeOptions; isAirForFrame?: (f: number, x: number, y: number) => boolean } = {},
): VoxelVolume[] {
  const quantized = frames.map((f) => quantizeFrame(f, palette, opts.quantize ?? { method: "bayer", gamutMap: 0.8, bayerAmplitude: 0.035 }));
  return framesToFlat3d(quantized, { depth: opts.depth ?? 2, isAirForFrame: opts.isAirForFrame });
}
