// VoxelVolume - the core 3D block model for the custom engine. A dense grid of
// map-colour ids (one byte per voxel); EMPTY marks air. Map colour ids are 0..~243,
// so 255 is a safe air sentinel. Index order is x-fastest then y then z.

export const EMPTY = 255;

export interface VoxelVolume {
  sx: number;
  sy: number;
  sz: number;
  data: Uint8Array; // length sx*sy*sz; mapColorId per voxel (EMPTY = air)
}

export function createVolume(sx: number, sy: number, sz: number): VoxelVolume {
  if (sx <= 0 || sy <= 0 || sz <= 0) throw new Error(`bad volume dims ${sx}x${sy}x${sz}`);
  const data = new Uint8Array(sx * sy * sz);
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
