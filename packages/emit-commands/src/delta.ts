import type { QuantizedFrame } from "@blockdream/color-core";

export interface Cell {
  x: number;
  y: number;
  mapColorId: number;
}

export interface FrameDelta {
  /** frame index */
  index: number;
  /** true for the first frame (a full keyframe, not a delta) */
  keyframe: boolean;
  /** cells to (re)place this frame */
  cells: Cell[];
}

/**
 * Delta-encode a sequence of equally-sized quantized frames.
 * Frame 0 is a full keyframe (every cell). Each later frame lists only the
 * cells whose block changed from the previous frame — this is what keeps the
 * per-tick command count bounded for vanilla playback.
 */
export function computeDeltas(frames: QuantizedFrame[]): FrameDelta[] {
  if (frames.length === 0) return [];
  const { width: W, height: H } = frames[0]!;
  const out: FrameDelta[] = [];
  for (let f = 0; f < frames.length; f++) {
    const cur = frames[f]!;
    if (cur.width !== W || cur.height !== H) {
      throw new Error(`frame ${f} is ${cur.width}×${cur.height}, expected ${W}×${H}`);
    }
    const cells: Cell[] = [];
    const prev = f === 0 ? undefined : frames[f - 1]!;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const id = cur.mapColorId[p]!;
        if (prev === undefined || prev.mapColorId[p] !== id) {
          cells.push({ x, y, mapColorId: id });
        }
      }
    }
    out.push({ index: f, keyframe: f === 0, cells });
  }
  return out;
}
