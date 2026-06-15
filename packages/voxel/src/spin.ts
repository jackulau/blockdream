// The "spin" engine: rotate a volume about an axis into an animation. Nearest-neighbour
// inverse sampling keeps the output the same dimensions and avoids holes. spin() returns
// a full turn split into nFrames - feed those to the 3D emitter or project them to 2D.

import { createVolume, getVoxel, setVoxel, EMPTY, type VoxelVolume } from "./volume";

export type SpinAxis = "x" | "y" | "z";

function rotate(v: VoxelVolume, angle: number, axis: SpinAxis): VoxelVolume {
  const out = createVolume(v.sx, v.sy, v.sz);
  const c = Math.cos(-angle); // inverse rotation: for each output voxel, find its source
  const s = Math.sin(-angle);
  const cx = (v.sx - 1) / 2;
  const cy = (v.sy - 1) / 2;
  const cz = (v.sz - 1) / 2;
  for (let z = 0; z < v.sz; z++) {
    for (let y = 0; y < v.sy; y++) {
      for (let x = 0; x < v.sx; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        let sx: number;
        let sy: number;
        let sz: number;
        if (axis === "y") {
          sx = cx + dx * c - dz * s;
          sy = y;
          sz = cz + dx * s + dz * c;
        } else if (axis === "x") {
          sx = x;
          sy = cy + dy * c - dz * s;
          sz = cz + dy * s + dz * c;
        } else {
          sx = cx + dx * c - dy * s;
          sy = cy + dx * s + dy * c;
          sz = z;
        }
        const val = getVoxel(v, Math.round(sx), Math.round(sy), Math.round(sz));
        if (val !== EMPTY) setVoxel(out, x, y, z, val);
      }
    }
  }
  return out;
}

export function rotateY(v: VoxelVolume, angle: number): VoxelVolume {
  return rotate(v, angle, "y");
}
export function rotateX(v: VoxelVolume, angle: number): VoxelVolume {
  return rotate(v, angle, "x");
}
export function rotateZ(v: VoxelVolume, angle: number): VoxelVolume {
  return rotate(v, angle, "z");
}

/** A full 360° turn about `axis`, split into nFrames volumes (frame 0 = identity). */
export function spin(v: VoxelVolume, nFrames: number, axis: SpinAxis = "y"): VoxelVolume[] {
  if (nFrames <= 0) throw new Error("spin needs nFrames > 0");
  const out: VoxelVolume[] = [];
  for (let i = 0; i < nFrames; i++) {
    out.push(rotate(v, (2 * Math.PI * i) / nFrames, axis));
  }
  return out;
}
