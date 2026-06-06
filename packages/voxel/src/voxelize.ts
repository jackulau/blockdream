// Turn a 2D quantized image into a 3D volume: either a flat slab of given thickness,
// or a heightmap terrain where each cell extrudes a column whose height comes from a
// per-cell metric (e.g. brightness). The heightOf callback decouples this package from
// the palette — the caller maps a map-colour id to a 0..1 height.

import type { QuantizedFrame } from "@mineworld/color-core";
import { createVolume, setVoxel, type VoxelVolume } from "./volume";

export interface VoxelizeOptions {
  mode?: "flat" | "heightmap";
  depth?: number; // flat: slab thickness in Z (default 1)
  maxHeight?: number; // heightmap: tallest column (default 16)
  heightOf?: (mapColorId: number) => number; // heightmap: cell → 0..1 fraction of maxHeight
}

export function imageToVolume(frame: QuantizedFrame, opts: VoxelizeOptions = {}): VoxelVolume {
  const { width, height } = frame;
  const mode = opts.mode ?? "flat";

  if (mode === "flat") {
    const depth = Math.max(1, Math.floor(opts.depth ?? 1));
    const v = createVolume(width, height, depth);
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const c = frame.mapColorId[iy * width + ix]!;
        const wy = height - 1 - iy; // image row 0 at the top → highest Y
        for (let z = 0; z < depth; z++) setVoxel(v, ix, wy, z, c);
      }
    }
    return v;
  }

  // heightmap: image is a top-down field; brightness → column height. x=img x, z=img y, y=up.
  const maxH = Math.max(1, Math.floor(opts.maxHeight ?? 16));
  const heightOf = opts.heightOf ?? (() => 1);
  const v = createVolume(width, maxH, height);
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const c = frame.mapColorId[iy * width + ix]!;
      const h = Math.max(1, Math.min(maxH, Math.round(heightOf(c) * maxH)));
      const wz = height - 1 - iy;
      for (let y = 0; y < h; y++) setVoxel(v, ix, y, wz, c);
    }
  }
  return v;
}
