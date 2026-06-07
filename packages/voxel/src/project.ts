// Project a 3D volume to a 2D QuantizedFrame (orthographic front view, looking along
// -Z): each (x,y) takes the nearest solid voxel. This lets a 3D spin be played through
// the existing, mature 2D block-wall animation pipeline (emit-commands datapack).
//
// The emit paths key on `mapColorId` (resolveBlock / map.dat), so paletteIndex is set to
// the map-colour id for type compatibility — it is not used for block resolution here.

import type { QuantizedFrame } from "@blockdream/color-core";
import { EMPTY, getVoxel, type VoxelVolume } from "./volume";

export function volumeToFrame(v: VoxelVolume): QuantizedFrame {
  const width = v.sx;
  const height = v.sy;
  const mapColorId = new Uint8Array(width * height);
  const paletteIndex = new Int32Array(width * height);
  for (let iy = 0; iy < height; iy++) {
    const wy = height - 1 - iy; // image row 0 at top → highest Y
    for (let ix = 0; ix < width; ix++) {
      let c = EMPTY;
      for (let z = 0; z < v.sz; z++) {
        const s = getVoxel(v, ix, wy, z);
        if (s !== EMPTY) {
          c = s;
          break;
        }
      }
      const p = iy * width + ix;
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
