// Project a 3D volume to a 2D QuantizedFrame (orthographic front view, looking along
// -Z): each (x,y) takes the nearest solid voxel. This lets a 3D spin be played through
// the existing, mature 2D block-wall animation pipeline (emit-commands datapack).
//
// The emit paths key on `mapColorId` (resolveBlock / map.dat), so paletteIndex is set to
// the map-colour id for type compatibility - it is not used for block resolution here.

import type { QuantizedFrame } from "@blockdream/color-core";
import { EMPTY, type VoxelVolume } from "./volume";

export function volumeToFrame(v: VoxelVolume): QuantizedFrame {
  const width = v.sx;
  const height = v.sy;
  const mapColorId = new Uint8Array(width * height);
  const paletteIndex = new Int32Array(width * height);
  const data = v.data;
  const zStride = v.sx * v.sy; // backing-index step between Z layers
  for (let iy = 0; iy < height; iy++) {
    const wy = height - 1 - iy; // image row 0 at top → highest Y
    const colBase = v.sx * wy; // backing index of (0, wy, 0)
    for (let ix = 0; ix < width; ix++) {
      let c = EMPTY;
      let idx = colBase + ix; // (ix, wy, 0); step +zStride per layer — all in bounds
      for (let z = 0; z < v.sz; z++) {
        const s = data[idx]!;
        if (s !== EMPTY) {
          c = s;
          break;
        }
        idx += zStride;
      }
      const p = iy * width + ix;
      // 0 is the air/transparent sentinel (Minecraft map-colour "none"); the solid quantizer only
      // emits canonical +2 shades, so 0 is unambiguous. The strict + web resolvers special-case it as
      // air (emit-commands AIR_MAP_COLOR_ID) so a projected EMPTY column never becomes base 0's block.
      const id = c === EMPTY ? 0 : c;
      mapColorId[p] = id;
      paletteIndex[p] = id;
    }
  }
  return { width, height, mapColorId, paletteIndex };
}

export function volumeToFrames(vs: VoxelVolume[]): QuantizedFrame[] {
  return vs.map(volumeToFrame);
}
