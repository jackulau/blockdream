// Flat, faithful voxelization — the deliberate OPPOSITE of imageToSolid (depth.ts).
//
// imageToSolid reconstructs a STILL image as a 3D object: it isolates a subject from its
// background and inflates a rounded dome by silhouette shape. That is exactly wrong for a flat
// 2D motion-graphic GIF/video: there is no "subject" to lift off a "background", and inflating a
// dome per frame turns a crisp 2D animation into a lumpy boiling blob that looks nothing like the
// source (the inflated-dome interior even dominates the bill-of-materials).
//
// imageToFlat keeps parity: the front face of the slab IS the image, block-for-block. No background
// isolation, no silhouette inflation, no shape-from-shading. A 2D animation stays a 2D animation,
// just rendered in blocks and (optionally) given a little thickness so it reads in the 3D viewer.

import type { QuantizedFrame } from "@blockdream/color-core";
import { createVolume, fillRun, MAX_DIM, type VoxelVolume } from "./volume";

export interface FlatImageOptions {
  /** Slab thickness in voxels — every kept pixel becomes a column of this many blocks, flush at the
   *  front face (z=0). Default 1 (a pure wall). Kept small on purpose: a flat source is faithful as a
   *  thin slab, not a solid. */
  depth?: number;
  /** Optional air test: return true for an image pixel that should be EMPTY (air) instead of a block.
   *  This is the transparency hook — a transparent GIF/video pixel maps to air so the subject floats
   *  instead of sitting on a filled rectangle; an opaque pixel always becomes a block. (x,y) are image
   *  coords. Default: every pixel is solid (full rectangle = the most literal reproduction). */
  isAir?: (x: number, y: number) => boolean;
}

/**
 * Voxelize a quantized image as a faithful flat slab. Output dims: width × height × depth. World Y is
 * flipped (image row 0 → top of the volume) to match imageToSolid and the rest of the pipeline, so the
 * build reads upright. Every non-air pixel's map-colour id is written straight to its column — the
 * viewer's front face is the image itself.
 */
export function imageToFlat(frame: QuantizedFrame, opts: FlatImageOptions = {}): VoxelVolume {
  const { width, height, mapColorId } = frame;
  if (width <= 0 || height <= 0) throw new Error(`imageToFlat: empty frame ${width}x${height}`);
  const depth = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.depth ?? 1)));
  const isAir = opts.isAir;
  const v = createVolume(width, height, depth);
  const zStride = v.sx * v.sy; // backing-index step between consecutive Z layers
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      if (isAir && isAir(ix, iy)) continue;
      const wy = height - 1 - iy; // flip image row → world Y (upright)
      const c = mapColorId[iy * width + ix]!;
      // column (ix, wy, 0..depth) is in bounds by construction → direct strided fill, no per-voxel branch
      fillRun(v, ix + v.sx * wy, zStride, depth, c);
    }
  }
  return v;
}

export interface FlatFramesOptions extends Omit<FlatImageOptions, "isAir"> {
  /** Per-frame air test (transparency): true → that pixel is air in frame f. (x,y) image coords. */
  isAirForFrame?: (frameIndex: number, x: number, y: number) => boolean;
  /** Single air test applied to every frame (used when transparency is frame-independent). */
  isAir?: (x: number, y: number) => boolean;
}

/**
 * Map imageToFlat over a frame sequence → one flat VoxelVolume per frame. The frames ARE the motion;
 * the caller plays them back with the source's real per-frame timing. No temporal "stabilizer" is
 * needed (or wanted) — there is no inflated depth field to boil, so each frame is independent and the
 * playback matches the source exactly.
 */
export function framesToFlat3d(frames: QuantizedFrame[], opts: FlatFramesOptions = {}): VoxelVolume[] {
  if (frames.length === 0) return [];
  const { isAirForFrame, isAir, depth } = opts;
  return frames.map((frame, f) =>
    imageToFlat(frame, {
      depth,
      isAir: isAirForFrame ? (x, y) => isAirForFrame(f, x, y) : isAir,
    }),
  );
}
