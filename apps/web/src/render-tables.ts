// Pure render tables + the hot per-pixel loop for the showcase's flat-wall → RGB path
// (goal 089 D12). showcase.ts ran `hexByMap.get(id) ?? 0x808080` per PIXEL inside
// rgbFromFlatVol's double loop - and over EVERY frame of a whole-video clip (up to 1500+
// frames, clip.map(rgbFromFlatVol)) synchronously in a click handler; the same Map served
// the viewer's per-material colorFor. mapColorIds are bytes (VoxelVolume data is a
// Uint8Array), so the whole id space fits a dense 256-slot Int32Array prefilled with the
// fallback: the lookup becomes one indexed load - no hashing, no undefined-coalesce.
// Byte-identical to the Map path by construction (locked in render-tables-perf.test.ts).

import { EMPTY, type VoxelVolume } from "@blockdream/voxel";
import type { RgbImage } from "@blockdream/color-core";

/** 0xRRGGBB fallback for ids outside the palette - the old `?? 0x808080`. */
export const HEX_FALLBACK = 0x808080;

/** Dense hex table over the whole one-byte mapColorId space: palette entries override the
 *  fallback (same iteration order as the old Map build - last write wins), every other id
 *  (including EMPTY) stays HEX_FALLBACK. Built once at module init from pal3d.entries. */
export function buildHexTable(
  entries: ReadonlyArray<{ color: { mapColorId: number; r: number; g: number; b: number } }>,
): Int32Array {
  const table = new Int32Array(256).fill(HEX_FALLBACK);
  for (const e of entries) {
    const c = e.color;
    table[c.mapColorId & 255] = (c.r << 16) | (c.g << 8) | c.b;
  }
  return table;
}

/**
 * Reconstruct an RGB image from a flat wall frame's FRONT layer (palette colour per block).
 * Whole-video clips are too long to keep their raw decoded RGB in memory; the wall itself is
 * the compact record, and its palette colours are exactly what any re-quantize would land on
 * anyway. KEEPS the `id === EMPTY ? 0` branch: air renders black, never the fallback gray.
 */
export function rgbFromFlatVol(v: VoxelVolume, hexTable: Int32Array): RgbImage {
  const { sx, sy } = v;
  const data = new Uint8Array(sx * sy * 3);
  for (let iy = 0; iy < sy; iy++) {
    const wy = sy - 1 - iy; // world Y is flipped vs image rows (imageToFlat keeps builds upright)
    for (let ix = 0; ix < sx; ix++) {
      const id = v.data[ix + sx * wy]!;
      const hex = id === EMPTY ? 0 : hexTable[id]!;
      const j = (iy * sx + ix) * 3;
      data[j] = (hex >> 16) & 255;
      data[j + 1] = (hex >> 8) & 255;
      data[j + 2] = hex & 255;
    }
  }
  return { width: sx, height: sy, data };
}
