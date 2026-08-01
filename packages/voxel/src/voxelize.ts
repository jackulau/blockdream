// Turn a 2D quantized image into a 3D volume: either a flat slab of given thickness,
// or a heightmap terrain where each cell extrudes a column whose height comes from a
// per-cell metric (e.g. brightness). The heightOf callback decouples this package from
// the palette - the caller maps a map-colour id to a 0..1 height.

import type { QuantizedFrame } from "@blockdream/color-core";
import { createVolume, fillRun, MAX_DIM, type VoxelVolume } from "./volume";

export interface VoxelizeOptions {
  mode?: "flat" | "heightmap" | "relief";
  depth?: number; // flat: slab thickness in Z (default 1); relief: MAX relief thickness (default 8)
  maxHeight?: number; // heightmap: tallest column (default 16)
  /** heightmap/relief: cell → 0..1 fraction. CONTRACT: a colour-id → height MAPPING - it must be
   *  deterministic per id within one imageToVolume call, because it is MEMOIZED per invocation
   *  (256-slot, mapColorId is a byte) and called once per DISTINCT id instead of once per pixel
   *  (mirrors emit-commands fill.ts idByColor). Invoked as a free function (`this` undefined).
   *  Locked by test/depth-hoist.test.ts. */
  heightOf?: (mapColorId: number) => number;
}

export function imageToVolume(frame: QuantizedFrame, opts: VoxelizeOptions = {}): VoxelVolume {
  const { width, height } = frame;
  const mode = opts.mode ?? "flat";

  if (mode === "flat") {
    const depth = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.depth ?? 1)));
    const v = createVolume(width, height, depth);
    const zStride = v.sx * v.sy;
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const c = frame.mapColorId[iy * width + ix]!;
        const wy = height - 1 - iy; // image row 0 at the top → highest Y
        fillRun(v, ix + v.sx * wy, zStride, depth, c); // (ix,wy,0..depth) in bounds → direct fill
      }
    }
    return v;
  }

  if (mode === "relief") {
    // Front-facing bas-relief: the picture stays upright + readable on the flush front face
    // (z=0), and each pixel extrudes BACKWARD by its brightness so the surface has real depth.
    // Unlike a flat slab, this reads as 3D from every angle (a flat slab vanishes edge-on when
    // spun). heightOf maps a colour id → 0..1; default = full depth (≡ a flat slab).
    const maxD = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.depth ?? 8)));
    const heightOf = opts.heightOf ?? (() => 1);
    const v = createVolume(width, height, maxD);
    const zStride = v.sx * v.sy;
    // Per-INVOCATION 256-slot memo (see the heightOf contract), mirroring emit-commands
    // fill.ts idByColor: 0 = unseen (a clamped run length is always >= 1), so the hit path is ONE
    // Int32Array load + compare. Per-call scope (not module) because the callback may close over
    // per-invocation state. A NaN result coerces to the 0 sentinel on store, so a NaN mapping just
    // recomputes per pixel (the computed local NaN still feeds fillRun -> writes nothing) -
    // byte-identical either way.
    const dByColor = new Int32Array(256);
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const c = frame.mapColorId[iy * width + ix]!;
        const wy = height - 1 - iy;
        let d: number = dByColor[c]!;
        if (d === 0) {
          d = Math.max(1, Math.min(maxD, Math.round(heightOf(c) * maxD)));
          dByColor[c] = d;
        }
        fillRun(v, ix + v.sx * wy, zStride, d, c); // flush front at z=0, recedes in +z
      }
    }
    return v;
  }

  // heightmap: image is a top-down field; brightness → column height. x=img x, z=img y, y=up.
  const maxH = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.maxHeight ?? 16)));
  const heightOf = opts.heightOf ?? (() => 1);
  const v = createVolume(width, maxH, height);
  const yStride = v.sx; // +y step; columns grow along Y here (heightmap is top-down)
  // same per-invocation 0-sentinel memo as relief above (identical clamp math -> byte-identical)
  const hByColor = new Int32Array(256);
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const c = frame.mapColorId[iy * width + ix]!;
      let h: number = hByColor[c]!;
      if (h === 0) {
        h = Math.max(1, Math.min(maxH, Math.round(heightOf(c) * maxH)));
        hByColor[c] = h;
      }
      const wz = height - 1 - iy;
      fillRun(v, ix + v.sx * v.sy * wz, yStride, h, c); // (ix,0..h,wz) in bounds → direct fill
    }
  }
  return v;
}

/**
 * VERBATIM pre-optimization imageToVolume - the reference twin for the goal-089 D22 per-invocation
 * heightOf memo above (the reference calls heightOf once per PIXEL). Kept exported (house
 * convention, see trisToVolumeReference in obj.ts) so test/depth-hoist.test.ts can prove
 * byte-identity. Not for production use.
 */
export function imageToVolumeReference(frame: QuantizedFrame, opts: VoxelizeOptions = {}): VoxelVolume {
  const { width, height } = frame;
  const mode = opts.mode ?? "flat";

  if (mode === "flat") {
    const depth = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.depth ?? 1)));
    const v = createVolume(width, height, depth);
    const zStride = v.sx * v.sy;
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const c = frame.mapColorId[iy * width + ix]!;
        const wy = height - 1 - iy; // image row 0 at the top → highest Y
        fillRun(v, ix + v.sx * wy, zStride, depth, c); // (ix,wy,0..depth) in bounds → direct fill
      }
    }
    return v;
  }

  if (mode === "relief") {
    const maxD = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.depth ?? 8)));
    const heightOf = opts.heightOf ?? (() => 1);
    const v = createVolume(width, height, maxD);
    const zStride = v.sx * v.sy;
    for (let iy = 0; iy < height; iy++) {
      for (let ix = 0; ix < width; ix++) {
        const c = frame.mapColorId[iy * width + ix]!;
        const wy = height - 1 - iy;
        const d = Math.max(1, Math.min(maxD, Math.round(heightOf(c) * maxD)));
        fillRun(v, ix + v.sx * wy, zStride, d, c); // flush front at z=0, recedes in +z
      }
    }
    return v;
  }

  // heightmap: image is a top-down field; brightness → column height. x=img x, z=img y, y=up.
  const maxH = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.maxHeight ?? 16)));
  const heightOf = opts.heightOf ?? (() => 1);
  const v = createVolume(width, maxH, height);
  const yStride = v.sx; // +y step; columns grow along Y here (heightmap is top-down)
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const c = frame.mapColorId[iy * width + ix]!;
      const h = Math.max(1, Math.min(maxH, Math.round(heightOf(c) * maxH)));
      const wz = height - 1 - iy;
      fillRun(v, ix + v.sx * v.sy * wz, yStride, h, c); // (ix,0..h,wz) in bounds → direct fill
    }
  }
  return v;
}
