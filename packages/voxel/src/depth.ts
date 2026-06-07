// Real shape-from-image voxelization. The old `relief` mode (see voxelize.ts) faked depth
// from pixel BRIGHTNESS extruded backward from a single front face — so a bright background
// became a thick slab, the subject was never isolated, and the result was one-sided (it
// vanished/﻿read as a flat card when spun edge-on).
//
// imageToSolid fixes all three:
//   1. Subject isolation — the background (border-connected dominant colour) is removed, so the
//      object floats in air and reads as an OBJECT, not a wall.
//   2. Depth follows SHAPE, not brightness — with no external depth map we "inflate" the
//      silhouette: a 2D distance transform makes pixels deep inside the subject bulge out and
//      pixels near the outline taper thin, giving a rounded, dome-like solid (the classic
//      puff/inflate reconstruction). With a real per-pixel depth map (an in-browser monocular
//      depth model, or a Blender depth pass) the thickness follows true depth instead.
//   3. Centered + double-sided — thickness is distributed SYMMETRICALLY about the mid-plane, so
//      both the front and back carry the image and the side silhouette shows the depth profile.
//      The object stays coherent from every viewing angle.

import type { QuantizedFrame } from "@mineworld/color-core";
import { createVolume, setVoxel, type VoxelVolume } from "./volume";

export interface SolidifyImageOptions {
  /** Max thickness of the solid, in voxels (the deepest part of the subject). Default 16. */
  maxDepth?: number;
  /** Background handling. "auto" removes the border-connected dominant colour; "none" keeps all
   *  pixels as subject. Default "auto". */
  background?: "auto" | "none";
  /** Explicit background test (overrides auto detection) — e.g. a palette's air id. */
  isBackground?: (mapColorId: number) => boolean;
  /** Real per-pixel depth in [0,1] (1 = thickest). Overrides the silhouette-inflation heuristic.
   *  This is the hook a depth MODEL or a Blender depth pass feeds. (x,y) are image coords. */
  depthOf?: (x: number, y: number) => number;
  /** Thickness response curve exponent applied to the normalized heuristic distance.
   *  <1 rounds the dome (default 0.5 = sqrt, a fuller bulge); 1 = linear cone. */
  curve?: number;
  /** Distribute thickness symmetrically about the mid-plane (default true). false = one-sided
   *  relief flush at z=0 (the old behaviour, kept for callers that want a wall-mounted plaque). */
  symmetric?: boolean;
}

/** 1 = background, 0 = subject. Flood-fills from the image border matching the dominant border
 *  colour (4-connected), so a solid backdrop is removed but a same-coloured region fully enclosed
 *  by the subject is kept. Returns an all-subject mask when no clear background exists. */
export function detectBackgroundMask(frame: QuantizedFrame): Uint8Array {
  const { width, height, mapColorId } = frame;
  const n = width * height;
  const mask = new Uint8Array(n); // 0 = subject
  // dominant colour along the border = presumed background
  const counts = new Map<number, number>();
  const tallyBorder = (i: number): void => {
    const c = mapColorId[i]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    tallyBorder(x);
    tallyBorder((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    tallyBorder(y * width);
    tallyBorder(y * width + width - 1);
  }
  let bg = -1;
  let best = -1;
  for (const [c, k] of counts)
    if (k > best) {
      best = k;
      bg = c;
    }
  if (bg < 0) return mask;
  // 4-connected flood from every border cell whose colour == bg
  const stack: number[] = [];
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (mask[i] || mapColorId[i] !== bg) return;
    mask[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return mask;
}

/** Chamfer (3-4 style, Euclidean-ish) distance from each subject cell to the nearest background
 *  cell OR the image edge. Background/edge sit at distance 0; the subject's interior grows out.
 *  Two passes, O(width·height). Returns distances (0 for background cells). */
export function silhouetteDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const D1 = 1; // orthogonal step
  const D2 = Math.SQRT2; // diagonal step
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? INF : 0; // subject = INF, background = 0
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? 0 : dist[y * width + x]!);
  // forward pass (top-left → bottom-right). OOB neighbours read as 0 → border tapers like an edge.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let d = dist[i]!;
      d = Math.min(d, at(x - 1, y) + D1, at(x, y - 1) + D1, at(x - 1, y - 1) + D2, at(x + 1, y - 1) + D2);
      dist[i] = d;
    }
  }
  // backward pass (bottom-right → top-left)
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let d = dist[i]!;
      d = Math.min(d, at(x + 1, y) + D1, at(x, y + 1) + D1, at(x + 1, y + 1) + D2, at(x - 1, y + 1) + D2);
      dist[i] = d;
    }
  }
  return dist;
}

/**
 * Turn a quantized image into a genuinely 3D, subject-isolated, centered solid.
 * Output dims: width × height × maxDepth. World Y is flipped (image row 0 → top) to match the
 * rest of the pipeline.
 */
export function imageToSolid(frame: QuantizedFrame, opts: SolidifyImageOptions = {}): VoxelVolume {
  const { width, height, mapColorId } = frame;
  const maxDepth = Math.max(1, Math.floor(opts.maxDepth ?? 16));
  const curve = opts.curve ?? 0.5;
  const symmetric = opts.symmetric ?? true;

  // subject mask
  let mask: Uint8Array;
  if (opts.isBackground) {
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = opts.isBackground(mapColorId[i]!) ? 0 : 1;
  } else if ((opts.background ?? "auto") === "none") {
    mask = new Uint8Array(width * height).fill(1);
  } else {
    const bg = detectBackgroundMask(frame);
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = bg[i] ? 0 : 1;
  }

  // thickness field in [0,1]
  const thickness = new Float32Array(width * height);
  if (opts.depthOf) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        thickness[i] = mask[i] ? Math.max(0, Math.min(1, opts.depthOf(x, y))) : 0;
      }
  } else {
    const dist = silhouetteDistance(mask, width, height);
    let maxd = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i]! > maxd) maxd = dist[i]!;
    const inv = maxd > 0 ? 1 / maxd : 0;
    for (let i = 0; i < dist.length; i++) thickness[i] = mask[i] ? Math.pow(dist[i]! * inv, curve) : 0;
  }

  const v = createVolume(width, height, maxDepth);
  const center = (maxDepth - 1) / 2; // mid-plane the solid is centered on
  for (let iy = 0; iy < height; iy++) {
    for (let ix = 0; ix < width; ix++) {
      const i = iy * width + ix;
      if (!mask[i]) continue;
      const t = thickness[i]!;
      if (t <= 0) continue;
      const d = Math.max(1, Math.min(maxDepth, Math.round(t * maxDepth)));
      const wy = height - 1 - iy;
      const c = mapColorId[i]!;
      let zlo: number;
      if (symmetric) {
        zlo = Math.round(center - (d - 1) / 2); // centered about the mid-plane → double-sided
        zlo = Math.max(0, Math.min(maxDepth - d, zlo));
      } else {
        zlo = 0; // one-sided relief, flush at the front face
      }
      for (let z = zlo; z < zlo + d; z++) setVoxel(v, ix, wy, z, c);
    }
  }
  return v;
}
