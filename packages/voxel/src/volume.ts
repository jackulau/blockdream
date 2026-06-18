// VoxelVolume - the core 3D block model for the custom engine. A dense grid of
// map-colour ids (one byte per voxel); EMPTY marks air. Map colour ids are 0..~243,
// so 255 is a safe air sentinel. Index order is x-fastest then y then z.

export const EMPTY = 255;

/** Per-axis size ceiling (voxels). Generous - a 512-deep build is already enormous for Minecraft -
 *  but it stops an absurd `maxDepth`/`resolution` from being treated as legitimate. */
export const MAX_DIM = 512;
/** Total-volume ceiling (voxels = bytes). ~64 MB; bounds the single allocation so a huge input can't
 *  OOM the process. A 400³ build (64 M) still fits; 1000³ (1 G) is rejected with a clear error. */
export const MAX_VOXELS = 64_000_000;

export interface VoxelVolume {
  sx: number;
  sy: number;
  sz: number;
  data: Uint8Array; // length sx*sy*sz; mapColorId per voxel (EMPTY = air)
}

export function createVolume(sx: number, sy: number, sz: number): VoxelVolume {
  if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(sz) || sx <= 0 || sy <= 0 || sz <= 0) {
    throw new Error(`bad volume dims ${sx}x${sy}x${sz}`);
  }
  const n = sx * sy * sz;
  if (n > MAX_VOXELS) {
    throw new Error(
      `volume ${sx}x${sy}x${sz} = ${n} voxels exceeds the ${MAX_VOXELS}-voxel cap; reduce resolution/depth`,
    );
  }
  const data = new Uint8Array(n);
  data.fill(EMPTY);
  return { sx, sy, sz, data };
}

export function voxelIndex(v: VoxelVolume, x: number, y: number, z: number): number {
  return x + v.sx * (y + v.sy * z);
}

export function inBounds(v: VoxelVolume, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < v.sx && y < v.sy && z < v.sz;
}

export function getVoxel(v: VoxelVolume, x: number, y: number, z: number): number {
  return inBounds(v, x, y, z) ? v.data[voxelIndex(v, x, y, z)]! : EMPTY;
}

export function setVoxel(v: VoxelVolume, x: number, y: number, z: number, c: number): void {
  if (inBounds(v, x, y, z)) v.data[voxelIndex(v, x, y, z)] = c;
}

/**
 * Fast in-bounds fill of a strided run — the hot-loop counterpart to `setVoxel`. Writes `len`
 * voxels starting at backing-array index `start`, stepping by `stride` (1 = +x, `sx` = +y,
 * `sx*sy` = +z). The CALLER guarantees the whole run is in bounds (the public `setVoxel` does the
 * per-voxel bounds check; this skips it because the fill loops feed provably-clamped indices). Used
 * to extrude a column/row without paying an `inBounds` branch per voxel.
 */
export function fillRun(v: VoxelVolume, start: number, stride: number, len: number, c: number): void {
  const data = v.data;
  let idx = start;
  for (let k = 0; k < len; k++) {
    data[idx] = c;
    idx += stride;
  }
}

export function countSolid(v: VoxelVolume): number {
  let n = 0;
  for (let i = 0; i < v.data.length; i++) if (v.data[i] !== EMPTY) n++;
  return n;
}

/** Visit every non-air voxel in x→y→z order. */
export function forEachSolid(v: VoxelVolume, cb: (x: number, y: number, z: number, c: number) => void): void {
  let i = 0;
  for (let z = 0; z < v.sz; z++) {
    for (let y = 0; y < v.sy; y++) {
      for (let x = 0; x < v.sx; x++) {
        const c = v.data[i++]!;
        if (c !== EMPTY) cb(x, y, z, c);
      }
    }
  }
}

export function cloneVolume(v: VoxelVolume): VoxelVolume {
  return { sx: v.sx, sy: v.sy, sz: v.sz, data: v.data.slice() };
}
