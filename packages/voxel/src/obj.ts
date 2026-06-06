// Import a 3D model (.obj) → a VoxelVolume by rasterizing each triangle's surface into the
// grid (a voxel shell of the mesh). Pure TS: parse `v`/`f`, normalize the mesh into a
// resolution³ box, and densely sample every triangle so no crossed voxel is missed.

import { createVolume, getVoxel, setVoxel, EMPTY, type VoxelVolume } from "./volume";

export interface ObjVoxelizeOptions {
  resolution?: number; // cube grid size (default 32)
  mapColorId?: number; // block colour id to fill the shell with (default 0)
  solid?: boolean; // fill the interior too (flood-fill from outside), not just the surface shell
}

type V3 = [number, number, number];

export function parseObj(obj: string): { verts: V3[]; tris: [number, number, number][] } {
  const verts: V3[] = [];
  const tris: [number, number, number][] = [];
  for (const line of obj.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "v" && t.length >= 4) {
      const x = Number(t[1]), y = Number(t[2]), z = Number(t[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`malformed vertex in .obj (non-numeric coordinate): "${line.trim()}"`);
      }
      verts.push([x, y, z]);
    } else if (t[0] === "f" && t.length >= 4) {
      const idx = t.slice(1).map((s) => {
        const n = parseInt(s.split("/")[0]!, 10);
        return n < 0 ? verts.length + n : n - 1; // OBJ is 1-indexed; negatives are relative
      });
      for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0]!, idx[i]!, idx[i + 1]!]); // fan-triangulate
    }
  }
  return { verts, tris };
}

export function objToVolume(obj: string, opts: ObjVoxelizeOptions = {}): VoxelVolume {
  const res = Math.max(2, Math.floor(opts.resolution ?? 32));
  const color = opts.mapColorId ?? 0;
  const { verts, tris } = parseObj(obj);
  if (verts.length === 0 || tris.length === 0) throw new Error("empty or invalid .obj (need v + f)");

  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      if (v[k]! < min[k]!) min[k] = v[k]!;
      if (v[k]! > max[k]!) max[k] = v[k]!;
    }
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) || 1;
  const scale = (res - 1) / extent;
  const grid = (v: V3): V3 => [(v[0]! - min[0]!) * scale, (v[1]! - min[1]!) * scale, (v[2]! - min[2]!) * scale];

  const vol = createVolume(res, res, res);
  for (const [ia, ib, ic] of tris) {
    const a = grid(verts[ia]!);
    const b = grid(verts[ib]!);
    const c = grid(verts[ic]!);
    const dist = (p: V3, q: V3) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const n = Math.max(2, Math.ceil(Math.max(dist(a, b), dist(a, c), dist(b, c))) * 2);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n;
        const w = j / n;
        const s = 1 - u - w;
        setVoxel(
          vol,
          Math.round(a[0]! * s + b[0]! * u + c[0]! * w),
          Math.round(a[1]! * s + b[1]! * u + c[1]! * w),
          Math.round(a[2]! * s + b[2]! * u + c[2]! * w),
          color,
        );
      }
    }
  }
  if (opts.solid) solidify(vol, color);
  return vol;
}

/**
 * Fill a watertight shell's interior. Flood-fills EMPTY from the grid boundary (6-connected)
 * to mark "outside"; every EMPTY cell the flood never reaches is interior → set to `color`.
 * Robust to a one-cell border because the rasterized shell is normalized to fit inside the
 * grid (it never touches all six faces), so the boundary is reliably outside.
 */
function solidify(vol: VoxelVolume, color: number): void {
  const { sx, sy, sz } = vol;
  const outside = new Uint8Array(sx * sy * sz);
  const at = (x: number, y: number, z: number) => (z * sy + y) * sx + x;
  const stack: number[] = [];
  const pushIfOpen = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    const i = at(x, y, z);
    if (outside[i] || getVoxel(vol, x, y, z) !== EMPTY) return;
    outside[i] = 1;
    stack.push(x, y, z);
  };
  // seed from every boundary cell
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) pushIfOpen(x, y, z);
  while (stack.length) {
    const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
    pushIfOpen(x + 1, y, z); pushIfOpen(x - 1, y, z);
    pushIfOpen(x, y + 1, z); pushIfOpen(x, y - 1, z);
    pushIfOpen(x, y, z + 1); pushIfOpen(x, y, z - 1);
  }
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (getVoxel(vol, x, y, z) === EMPTY && !outside[at(x, y, z)]) setVoxel(vol, x, y, z, color);
}
