// Browser glue for "import an animation video → animated 3D blocks". The temporally-stable
// frame→solid conversion is the pure framesToAnimated3d in @blockdream/voxel (shared with the CLI);
// here we add the browser-side decode + quantize step. Each decoded RGB frame is matched to the 3D
// block palette, then turned into a real subject-isolated solid (NOT the old flat depth-2 slab).

import { framesToAnimated3d, type Video3dOptions, type VoxelVolume } from "@blockdream/voxel";
import { quantizeFrame, type RgbImage } from "@blockdream/color-core";

export { framesToAnimated3d };
export type { Video3dOptions };

type Palette = Parameters<typeof quantizeFrame>[1];

/** Quantize a sequence of decoded RGB frames to the block palette, then voxelize them into a
 *  temporally-coherent 3D block animation. */
export function rgbFramesToAnimated3d(frames: RgbImage[], palette: Palette, opts: Video3dOptions = {}): VoxelVolume[] {
  const quantized = frames.map((f) => quantizeFrame(f, palette, { method: "none" }));
  return framesToAnimated3d(quantized, opts);
}
