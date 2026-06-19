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

/**
 * Exact 90°-step yaw rotation about Y - LOSSLESS, no sampling. For odd quarter-turns the
 * footprint swaps (a W×H×D build becomes D×H×W), so a non-cubic build never clips - unlike the
 * sampling {@link rotateY}, which keeps the original box (right for the spin animation, wrong for a
 * static orientation). `turns` is taken mod 4; 0 = identity. This backs `--facing` (build direction).
 */
export function rotateYQuarterTurns(v: VoxelVolume, turns: number): VoxelVolume {
  const t = (((Math.round(turns) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  if (t === 0) return v;
  const swap = t === 1 || t === 3;
  const out = createVolume(swap ? v.sz : v.sx, v.sy, swap ? v.sx : v.sz);
  for (let z = 0; z < v.sz; z++) {
    for (let y = 0; y < v.sy; y++) {
      for (let x = 0; x < v.sx; x++) {
        const val = getVoxel(v, x, y, z);
        if (val === EMPTY) continue;
        let nx: number;
        let nz: number;
        if (t === 1) {
          nx = z;
          nz = v.sx - 1 - x;
        } else if (t === 2) {
          nx = v.sx - 1 - x;
          nz = v.sz - 1 - z;
        } else {
          nx = v.sz - 1 - z;
          nz = x;
        }
        setVoxel(out, nx, y, nz, val);
      }
    }
  }
  return out;
}

/** Centre `v` in a SQUARE X/Z footprint (max(sx,sz) on both axes), keeping sy. A Y-spin then
 *  rotates inside a square base, so a non-cubic build (the common W×H×shallow-depth case) never
 *  clips its width into the depth axis. No-op when already square in X/Z. */
export function padXZToSquare(v: VoxelVolume): VoxelVolume {
  const d = Math.max(v.sx, v.sz);
  if (v.sx === d && v.sz === d) return v;
  const out = createVolume(d, v.sy, d);
  const ox = (d - v.sx) >> 1;
  const oz = (d - v.sz) >> 1;
  for (let z = 0; z < v.sz; z++)
    for (let y = 0; y < v.sy; y++)
      for (let x = 0; x < v.sx; x++) {
        const val = getVoxel(v, x, y, z);
        if (val !== EMPTY) setVoxel(out, x + ox, y, z + oz, val);
      }
  return out;
}

/** A baked full Y-spin: `frames` volumes of the build rotating in place. Cube-pads X/Z first so a
 *  non-cubic build never clips. This is the rotating-build animation for a vanilla datapack. */
export function spinSequence(v: VoxelVolume, frames = 24): VoxelVolume[] {
  return spin(padXZToSquare(v), frames, "y");
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
