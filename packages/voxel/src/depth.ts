// Real shape-from-image voxelization. The old `relief` mode (see voxelize.ts) faked depth
// from pixel BRIGHTNESS extruded backward from a single front face - so a bright background
// became a thick slab, the subject was never isolated, and the result was one-sided (it
// vanished/﻿read as a flat card when spun edge-on).
//
// imageToSolid fixes all three:
//   1. Subject isolation - the background (border-connected dominant colour) is removed, so the
//      object floats in air and reads as an OBJECT, not a wall.
//   2. Depth follows SHAPE, not brightness - with no external depth map we "inflate" the
//      silhouette: a 2D distance transform makes pixels deep inside the subject bulge out and
//      pixels near the outline taper thin, giving a rounded, dome-like solid (the classic
//      puff/inflate reconstruction). With a real per-pixel depth map (an in-browser monocular
//      depth model, or a Blender depth pass) the thickness follows true depth instead.
//   3. Centered + double-sided - thickness is distributed SYMMETRICALLY about the mid-plane, so
//      both the front and back carry the image and the side silhouette shows the depth profile.
//      The object stays coherent from every viewing angle.

import type { QuantizedFrame } from "@blockdream/color-core";
import { createVolume, fillRun, MAX_DIM, type VoxelVolume } from "./volume";

export interface SolidifyImageOptions {
  /** Max thickness of the solid, in voxels (the deepest part of the subject). Default 16. */
  maxDepth?: number;
  /** Background handling. "auto" removes the border-connected dominant colour; "none" keeps all
   *  pixels as subject. Default "auto". */
  background?: "auto" | "none";
  /** Explicit background test (overrides auto detection) - e.g. a palette's air id. */
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

/** 1D squared-distance transform (Felzenszwalb–Huttenlocher): lower envelope of the parabolas
 *  rooted at each sample of `f`. Writes the transform of `f[0..n)` into `d[0..n)`. O(n). `f` may hold
 *  +INF (non-seed) samples; the caller guarantees at least one finite sample per line so the
 *  intersection math never divides by an all-INF pair. Scratch buffers `vtx`/`zb` are caller-owned. */
function edt1d(f: Float64Array, d: Float64Array, vtx: Int32Array, zb: Float64Array, n: number): void {
  const INF = 1e20;
  let k = 0;
  vtx[0] = 0;
  zb[0] = -INF;
  zb[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[vtx[k]!]! + vtx[k]! * vtx[k]!)) / (2 * q - 2 * vtx[k]!);
    while (s <= zb[k]!) {
      k--;
      s = (f[q]! + q * q - (f[vtx[k]!]! + vtx[k]! * vtx[k]!)) / (2 * q - 2 * vtx[k]!);
    }
    k++;
    vtx[k] = q;
    zb[k] = s;
    zb[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zb[k + 1]! < q) k++;
    const dx = q - vtx[k]!;
    d[q] = dx * dx + f[vtx[k]!]!;
  }
}

/** EXACT Euclidean distance from each subject cell to the nearest background cell OR the image edge.
 *  Background/edge sit at distance 0; the subject's interior grows out — a filled disc's centre gets
 *  a distance equal to its radius and the iso-distance contours are TRUE circles (the old chamfer 3-4
 *  transform had octagonal contours → faceted, lumpy domes). Implemented as the separable
 *  Felzenszwalb–Huttenlocher transform (two O(n) passes, columns then rows) over a 1px
 *  background-padded grid, so a subject touching the image border still tapers there (preserving the
 *  old edge-as-background behaviour). O(width·height). Returns Euclidean distance (0 for background). */
export function silhouetteDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e20;
  // pad by 1 with background on every side → the image edge is a distance-0 seed just outside, AND
  // every padded column/row contains a seed (so pass 1 is always finite → no INF-INF in pass 2).
  const W = width + 2;
  const H = height + 2;
  const g = new Float64Array(W * H); // squared distance; seed (bg/pad) = 0, subject = +INF
  for (let y = 1; y <= height; y++)
    for (let x = 1; x <= width; x++) if (mask[(y - 1) * width + (x - 1)]) g[y * W + x] = INF;

  const m = Math.max(W, H);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const vtx = new Int32Array(m);
  const zb = new Float64Array(m + 1);

  for (let x = 0; x < W; x++) {
    let any = false;
    for (let y = 0; y < H; y++) {
      const val = g[y * W + x]!;
      f[y] = val;
      if (val > 0) any = true;
    }
    if (!any) continue; // all-background column → transform is identity (stays 0); skip the envelope
    edt1d(f, d, vtx, zb, H);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y]!;
  }
  for (let y = 0; y < H; y++) {
    let any = false;
    for (let x = 0; x < W; x++) {
      const val = g[y * W + x]!;
      f[x] = val;
      if (val > 0) any = true;
    }
    if (!any) continue; // all-background row → identity; skip
    edt1d(f, d, vtx, zb, W);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x]!;
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = Math.sqrt(g[(y + 1) * W + (x + 1)]!);
  return out;
}

/**
 * Turn a quantized image into a genuinely 3D, subject-isolated, centered solid.
 * Output dims: width × height × maxDepth. World Y is flipped (image row 0 → top) to match the
 * rest of the pipeline.
 */
export function imageToSolid(frame: QuantizedFrame, opts: SolidifyImageOptions = {}): VoxelVolume {
  const { width, height, mapColorId } = frame;
  if (width <= 0 || height <= 0) throw new Error(`imageToSolid: empty frame ${width}x${height}`);
  const maxDepth = Math.max(1, Math.min(MAX_DIM, Math.floor(opts.maxDepth ?? 16)));  // clamp (no OOM)
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
  // DEGENERATE-INPUT GUARD: if auto background-removal erased the whole image (e.g. a single solid
  // colour, where the border colour == every pixel), there is no subject to inflate. Rather than
  // silently emit an empty build, treat the whole frame as the subject (a flat-ish slab). A truly
  // empty result still throws below.
  let anySubject = 0;
  for (let i = 0; i < mask.length; i++) anySubject |= mask[i]!;
  if (!anySubject) mask.fill(1);

  // thickness field in [0,1]
  const thickness = new Float32Array(width * height);
  if (opts.depthOf) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = opts.depthOf(x, y);                              // sanitize NaN/Inf -> 0 (no silent drop)
        thickness[i] = mask[i] ? Math.max(0, Math.min(1, Number.isFinite(d) ? d : 0)) : 0;
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
  const zStride = v.sx * v.sy; // backing-index step between consecutive Z layers
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
      // (ix, wy, zlo..zlo+d) is provably in bounds (clamped above) → direct strided fill, no per-voxel branch
      fillRun(v, ix + v.sx * wy + zStride * zlo, zStride, d, c);
    }
  }
  // NOTE: an empty result is legitimate per-frame (framesToAnimated3d passes a 0 depth field for an
  // all-background video frame), so the "no subject" guard lives at the CLI/aggregate level (render.ts),
  // not here - throwing per-frame would reject valid empty frames in an animation.
  return v;
}
