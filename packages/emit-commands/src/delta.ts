import type { QuantizedFrame } from "@blockdream/color-core";
import type { PlacedCell } from "./fill";

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
 * cells whose block changed from the previous frame - this is what keeps the
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

/** {@link computePlacedDeltas} frame: same delta structure, WORLD-coordinate cells. */
export interface PlacedFrameDelta {
  index: number;
  keyframe: boolean;
  cells: PlacedCell[];
}

/**
 * Fused delta + world mapping for the 2D wall emitters (datapack, behaviorpack): the
 * delta scan and the grid→world map (`x+origin.x`, image row 0 at the TOP of the wall,
 * constant z) emit the {@link PlacedCell} shape in ONE pass. The emitters previously ran
 * `computeDeltas` (one {x,y,mapColorId} object per changed cell, all frames retained
 * simultaneously) and then re-mapped EVERY cell into {x,y,z,mapColorId} solely to feed
 * `greedyBoxes` - two objects per cell where one suffices. Cell order and world math are
 * exactly {@link referencePlacedDeltas}' (byte-identical emitted pack lines, locked by
 * delta-fuse.test.ts). `computeDeltas` stays the public grid-shaped API (bedrock-script,
 * live rcon-bridge).
 */
export function computePlacedDeltas(
  frames: QuantizedFrame[],
  height: number,
  origin: { x: number; y: number; z: number },
): PlacedFrameDelta[] {
  if (frames.length === 0) return [];
  const { width: W, height: H } = frames[0]!;
  const out: PlacedFrameDelta[] = [];
  const ox = origin.x;
  const topY = origin.y + height - 1; // image row 0 at top
  const oz = origin.z;
  for (let f = 0; f < frames.length; f++) {
    const cur = frames[f]!;
    if (cur.width !== W || cur.height !== H) {
      throw new Error(`frame ${f} is ${cur.width}×${cur.height}, expected ${W}×${H}`);
    }
    const cells: PlacedCell[] = [];
    const prev = f === 0 ? undefined : frames[f - 1]!;
    for (let y = 0; y < H; y++) {
      const wy = topY - y;
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const id = cur.mapColorId[p]!;
        if (prev === undefined || prev.mapColorId[p] !== id) {
          cells.push({ x: ox + x, y: wy, z: oz, mapColorId: id });
        }
      }
    }
    out.push({ index: f, keyframe: f === 0, cells });
  }
  return out;
}

/**
 * Reference twin for {@link computePlacedDeltas}, kept verbatim as the emitters' old
 * two-pass pipeline: `computeDeltas` (grid cells) followed by the per-frame world map
 * the emitters called `framePlacedCells`. Exported only for the byte-identity + timing
 * gate in delta-fuse.test.ts. Do not optimize.
 */
export function referencePlacedDeltas(
  frames: QuantizedFrame[],
  height: number,
  origin: { x: number; y: number; z: number },
): PlacedFrameDelta[] {
  return computeDeltas(frames).map((d) => ({
    index: d.index,
    keyframe: d.keyframe,
    cells: d.cells.map((c) => ({
      x: origin.x + c.x,
      y: origin.y + (height - 1 - c.y),
      z: origin.z,
      mapColorId: c.mapColorId,
    })),
  }));
}
