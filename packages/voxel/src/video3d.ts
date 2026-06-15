// Video (or GIF) → animated 3D blocks. Each frame becomes a real subject-isolated SOLID (via
// imageToSolid), not the old flat depth-2 slab. Two stability measures keep the animation from
// boiling frame-to-frame:
//   • GLOBAL depth normalization - the silhouette-thickness of every frame is normalized by ONE
//     shared maximum across the whole clip, so the build doesn't pop thicker/thinner as the subject
//     grows or shrinks. (Per-frame normalization is the usual cause of depth flicker.)
//   • optional temporal EMA - light exponential smoothing of the thickness field across frames.
// A real per-pixel depth source (a monocular depth model, or a Blender depth-pass sidecar) can be
// supplied via opts.depthForFrame to replace the silhouette heuristic on natural footage.

import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid, detectBackgroundMask, silhouetteDistance, type SolidifyImageOptions } from "./depth";
import type { VoxelVolume } from "./volume";

export interface Video3dOptions extends SolidifyImageOptions {
  /** Temporal smoothing of the thickness field, 0..1 (0 = off, default 0.35). Higher = steadier
   *  depth but more ghosting on fast motion. */
  smooth?: number;
  /** Real per-pixel depth [0,1] for frame f (e.g. a depth model). Overrides the silhouette heuristic. */
  depthForFrame?: (frameIndex: number, x: number, y: number) => number;
}

/** Raw (un-normalized) silhouette distance field + subject mask for one frame. */
function rawDepth(frame: QuantizedFrame, isBackground?: (id: number) => boolean): { dist: Float32Array; mask: Uint8Array } {
  const { width, height, mapColorId } = frame;
  let mask: Uint8Array;
  if (isBackground) {
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = isBackground(mapColorId[i]!) ? 0 : 1;
  } else {
    const bg = detectBackgroundMask(frame);
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = bg[i] ? 0 : 1;
  }
  return { dist: silhouetteDistance(mask, width, height), mask };
}

/**
 * Convert a sequence of quantized frames into temporally-coherent 3D block volumes.
 * Returns one VoxelVolume per frame, all sized width × height × maxDepth.
 */
export function framesToAnimated3d(frames: QuantizedFrame[], opts: Video3dOptions = {}): VoxelVolume[] {
  if (frames.length === 0) return [];
  const curve = opts.curve ?? 0.5;
  const smooth = Math.max(0, Math.min(1, opts.smooth ?? 0.35));

  // 1. global normalization factor over the whole clip (shared depth scale → no per-frame popping)
  const raws = opts.depthForFrame ? null : frames.map((f) => rawDepth(f, opts.isBackground));
  let globalMax = 0;
  if (raws) for (const r of raws) for (let i = 0; i < r.dist.length; i++) if (r.dist[i]! > globalMax) globalMax = r.dist[i]!;
  const inv = globalMax > 0 ? 1 / globalMax : 0;

  // 2. per-frame thickness, optionally EMA-smoothed across time
  const out: VoxelVolume[] = [];
  let prev: Float32Array | null = null;
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]!;
    const n = frame.width * frame.height;
    const th = new Float32Array(n);
    if (opts.depthForFrame) {
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) th[y * frame.width + x] = Math.max(0, Math.min(1, opts.depthForFrame(f, x, y)));
    } else {
      const r = raws![f]!;
      for (let i = 0; i < n; i++) th[i] = r.mask[i] ? Math.pow(r.dist[i]! * inv, curve) : 0;
    }
    if (prev && prev.length === n && smooth > 0) for (let i = 0; i < n; i++) th[i] = (1 - smooth) * th[i]! + smooth * prev[i]!;
    prev = th;
    out.push(imageToSolid(frame, { ...opts, curve, depthOf: (x, y) => th[y * frame.width + x]! }));
  }
  return out;
}
