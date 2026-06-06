// Import a 3D model (.obj) → a VoxelVolume by rasterizing each triangle's surface into the
// grid (a voxel shell of the mesh). Pure TS: parse `v`/`f`, normalize the mesh into a
// resolution³ box, and densely sample every triangle so no crossed voxel is missed.

import { createVolume, setVoxel, type VoxelVolume } from "./volume";

export interface ObjVoxelizeOptions {
  resolution?: number; // cube grid size (default 32)
  mapColorId?: number; // block colour id to fill the shell with (default 0)
}

type V3 = [number, number, number];

export function parseObj(obj: string): { verts: V3[]; tris: [number, number, number][] } {
  const verts: V3[] = [];
  const tris: [number, number, number][] = [];
  for (const line of obj.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "v" && t.length >= 4) {
      verts.push([Number(t[1]), Number(t[2]), Number(t[3])]);
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
  return vol;
}
