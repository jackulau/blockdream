// Import a 3D model (.obj) → a VoxelVolume by rasterizing each triangle's surface into the
// grid (a voxel shell of the mesh), optionally flood-filling the interior solid. Pure TS.
// The triangle rasterizer (trisToVolume) is shared with the glTF / animated-sequence importer
// (gltf.ts) and accepts SHARED bounds so a whole animation can be voxelized into one consistent
// world box - the object then moves/deforms in place instead of being re-fit every frame.

import { createVolume, setVoxel, EMPTY, type VoxelVolume } from "./volume";

/**
 * Default block colour for uncoloured mesh geometry: the light-gray base (baseId 22) at its
 * canonical full shade (baseId*4 + 2 = 90), which the solid block resolver maps to a real
 * placeable block (light gray concrete). Id 0 is NOT a usable default: map colour 0 is the
 * downstream air/transparent sentinel (emit-commands AIR_MAP_COLOR_ID), so an uncoloured mesh
 * (most real .obj/.glb exports) rasterized with 0 would voxelize "successfully" and then emit
 * a 100% air pack with exit 0.
 */
export const DEFAULT_MODEL_MAP_COLOR_ID = 90;

export interface ObjVoxelizeOptions {
  resolution?: number; // cube grid size (default 32)
  mapColorId?: number; // block colour id to fill the shell with (default DEFAULT_MODEL_MAP_COLOR_ID, a placeable light gray)
  solid?: boolean; // fill the interior too (flood-fill from outside), not just the surface shell
  /** sRGB (0..255) → mapColorId, e.g. a color-core OKLab nearest-match against the placeable
   *  palette. When supplied AND the source carries vertex colors, each triangle gets its own
   *  matched block instead of the single mapColorId. */
  matchColor?: (r: number, g: number, b: number) => number;
}

export type V3 = [number, number, number];
export type Tri = [number, number, number];
export interface Bounds {
  min: V3;
  max: V3;
}

export function parseObj(obj: string): { verts: V3[]; tris: Tri[]; colors?: V3[] } {
  const verts: V3[] = [];
  const tris: Tri[] = [];
  const colors: V3[] = [];
  let anyColor = false;
  for (const line of obj.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "v" && t.length >= 4) {
      const x = Number(t[1]), y = Number(t[2]), z = Number(t[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`malformed vertex in .obj (non-numeric coordinate): "${line.trim()}"`);
      }
      verts.push([x, y, z]);
      // the common .obj vertex-color extension: "v x y z r g b" with r/g/b in 0..1
      if (t.length >= 7) {
        const r = Number(t[4]), g = Number(t[5]), b = Number(t[6]);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          colors.push([r, g, b]);
          anyColor = true;
        } else colors.push([1, 1, 1]);
      } else colors.push([1, 1, 1]);
    } else if (t[0] === "f" && t.length >= 4) {
      const idx = t.slice(1).map((s) => {
        const n = parseInt(s.split("/")[0]!, 10);
        return n < 0 ? verts.length + n : n - 1; // OBJ is 1-indexed; negatives are relative
      });
      // a row like "f //1 //2 //3" parses to NaN indices (parseInt("") = NaN), which sail past the
      // rasterizer's range guard (every NaN comparison is false) and crash on verts[NaN] - skip it
      if (idx.some((n) => !Number.isFinite(n))) continue;
      for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0]!, idx[i]!, idx[i + 1]!]); // fan-triangulate
    }
  }
  return anyColor ? { verts, tris, colors } : { verts, tris };
}

/** Axis-aligned bounds of a vertex set. */
export function meshBounds(verts: V3[]): Bounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      if (v[k]! < min[k]!) min[k] = v[k]!;
      if (v[k]! > max[k]!) max[k] = v[k]!;
    }
  return { min, max };
}

/** Union of several bounds - the shared world box for an animation/sequence. */
export function unionBounds(all: Bounds[]): Bounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of all)
    for (let k = 0; k < 3; k++) {
      if (b.min[k]! < min[k]!) min[k] = b.min[k]!;
      if (b.max[k]! > max[k]!) max[k] = b.max[k]!;
    }
  return { min, max };
}

export interface RasterOptions extends ObjVoxelizeOptions {
  bounds?: Bounds; // shared normalization box (for an animation); defaults to this mesh's own bounds
  /** Per-triangle block id (overrides mapColorId for that triangle's surface voxels). */
  colorOf?: (triIndex: number) => number;
}

// Module-local so the rasterizer's per-triangle edge lengths cost neither a closure allocation
// (the old `dist` arrow was re-created for EVERY triangle) nor, under vite-node, an
// exports-object getter lookup. Operand order matches the old dist(p, q) exactly: p[k] - q[k].
function dist3(px: number, py: number, pz: number, qx: number, qy: number, qz: number): number {
  return Math.hypot(px - qx, py - qy, pz - qz);
}

/** Rasterize a triangle mesh into a res³ volume. With `bounds` supplied, the mesh is normalized into
 *  that shared box (uniform scale, preserving aspect) so a sequence of meshes lands in one world frame.
 *  Byte-identical to `trisToVolumeReference` (locked by obj-perf.test.ts): same sample order, same
 *  float expressions, minus the per-vertex grid() arrays, per-triangle dist closure, per-sample
 *  uu = i/n recompute and per-sample setVoxel call. */
export function trisToVolume(verts: V3[], tris: Tri[], opts: RasterOptions = {}): VoxelVolume {
  const res = Math.max(2, Math.floor(opts.resolution ?? 32));
  const fallback = opts.mapColorId ?? DEFAULT_MODEL_MAP_COLOR_ID;
  if (verts.length === 0 || tris.length === 0) throw new Error("empty mesh (need vertices + triangles)");

  const b = opts.bounds ?? meshBounds(verts);
  const extent = Math.max(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!, b.max[2]! - b.min[2]!) || 1;
  const scale = (res - 1) / extent;
  // scratch scalars replace the old grid() 3-array-per-vertex-per-triangle; same (v[k] - min[k]) * scale
  const m0 = b.min[0]!, m1 = b.min[1]!, m2 = b.min[2]!;

  const vol = createVolume(res, res, res);
  const data = vol.data;
  for (let t = 0; t < tris.length; t++) {
    const [ia, ib, ic] = tris[t]!;
    // Number.isInteger also rejects NaN, which passes every < / >= comparison (defense for callers
    // that build tris without parseObj - gltf.ts and direct trisToVolume use)
    if (!Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic)) continue;
    if (ia < 0 || ib < 0 || ic < 0 || ia >= verts.length || ib >= verts.length || ic >= verts.length) continue;
    const color = opts.colorOf?.(t) ?? fallback;
    const va = verts[ia]!, vb = verts[ib]!, vc = verts[ic]!;
    const ax = (va[0]! - m0) * scale, ay = (va[1]! - m1) * scale, az = (va[2]! - m2) * scale;
    const bx = (vb[0]! - m0) * scale, by = (vb[1]! - m1) * scale, bz = (vb[2]! - m2) * scale;
    const cx = (vc[0]! - m0) * scale, cy = (vc[1]! - m1) * scale, cz = (vc[2]! - m2) * scale;
    const n = Math.max(
      2,
      Math.ceil(Math.max(dist3(ax, ay, az, bx, by, bz), dist3(ax, ay, az, cx, cy, cz), dist3(bx, by, bz, cx, cy, cz))) * 2,
    );
    for (let i = 0; i <= n; i++) {
      const uu = i / n; // loop-invariant in j (do NOT rewrite the divisions as * (1/n): that changes bits)
      for (let j = 0; i + j <= n; j++) {
        const w = j / n;
        const s = 1 - uu - w;
        const x = Math.round(ax * s + bx * uu + cx * w);
        const y = Math.round(ay * s + by * uu + cy * w);
        const z = Math.round(az * s + bz * uu + cz * w);
        // inlined setVoxel: identical bounds check + x-fastest index, minus the per-sample call
        if (x >= 0 && y >= 0 && z >= 0 && x < res && y < res && z < res) data[x + res * (y + res * z)] = color;
      }
    }
  }
  if (opts.solid) solidify(vol, fallback);
  return vol;
}

export function objToVolume(obj: string, opts: ObjVoxelizeOptions = {}): VoxelVolume {
  const { verts, tris, colors } = parseObj(obj);
  if (verts.length === 0 || tris.length === 0) throw new Error("empty or invalid .obj (need v + f)");
  let colorOf: ((t: number) => number) | undefined;
  if (colors && opts.matchColor) {
    const match = opts.matchColor;
    const cache = new Map<number, number>();
    colorOf = (t: number) => {
      const [ia, ib, ic] = tris[t]!;
      const r = ((colors[ia]![0]! + colors[ib]![0]! + colors[ic]![0]!) / 3) * 255;
      const g = ((colors[ia]![1]! + colors[ib]![1]! + colors[ic]![1]!) / 3) * 255;
      const bch = ((colors[ia]![2]! + colors[ib]![2]! + colors[ic]![2]!) / 3) * 255;
      const key = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bch);
      let id = cache.get(key);
      if (id === undefined) cache.set(key, (id = match(r, g, bch)));
      return id;
    };
  }
  return trisToVolume(verts, tris, { ...opts, colorOf });
}

/**
 * Fill a watertight shell's interior. Flood-fills EMPTY from the grid boundary (6-connected)
 * to mark "outside"; every EMPTY cell the flood never reaches is interior → set to `color`.
 *
 * Byte-identical to `solidifyReference` (locked by obj-perf.test.ts): the flood's reached SET is
 * order-independent and the final pass is a linear scan, so seeding only the 6 boundary planes
 * (instead of a full O(volume) scan), an Int32Array stack of linear indices (instead of x,y,z
 * triple-pushes into a number[]) and inlined neighbor checks (instead of a closure called 6x per
 * popped cell) change visit ORDER only, never the output volume.
 */
export function solidify(vol: VoxelVolume, color: number): void {
  const { sx, sy, sz } = vol;
  const data = vol.data;
  const air = EMPTY; // local capture: an imported binding is an exports-getter lookup under vite-node
  const total = sx * sy * sz;
  const zStride = sx * sy;
  const outside = new Uint8Array(total);
  // Each cell is marked `outside` before it is pushed, so it enters the stack at most once and
  // `total` bounds the stack exactly.
  const stack = new Int32Array(total);
  let top = 0;
  // seed the 6 boundary planes only (edge/corner cells appear in several planes; the outside[]
  // guard dedups them, exactly like the old full-scan seed did)
  for (let y = 0; y < sy; y++) {
    const lo = sx * y; // z = 0
    const hi = lo + zStride * (sz - 1); // z = sz - 1
    for (let x = 0; x < sx; x++) {
      let i = lo + x;
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
      i = hi + x;
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
    }
  }
  for (let z = 0; z < sz; z++) {
    const lo = zStride * z; // y = 0
    const hi = lo + sx * (sy - 1); // y = sy - 1
    for (let x = 0; x < sx; x++) {
      let i = lo + x;
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
      i = hi + x;
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
    }
  }
  for (let z = 0; z < sz; z++) {
    const base = zStride * z;
    for (let y = 0; y < sy; y++) {
      let i = base + sx * y; // x = 0
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
      i += sx - 1; // x = sx - 1
      if (!outside[i] && data[i] === air) { outside[i] = 1; stack[top++] = i; }
    }
  }
  while (top > 0) {
    const i = stack[--top]!;
    // recover coords from the linear index for the edge guards
    const x = i % sx;
    const rest = (i - x) / sx; // == y + sy * z
    const y = rest % sy;
    const z = (rest - y) / sy;
    if (x + 1 < sx) { const j = i + 1; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
    if (x > 0) { const j = i - 1; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
    if (y + 1 < sy) { const j = i + sx; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
    if (y > 0) { const j = i - sx; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
    if (z + 1 < sz) { const j = i + zStride; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
    if (z > 0) { const j = i - zStride; if (!outside[j] && data[j] === air) { outside[j] = 1; stack[top++] = j; } }
  }
  // full-volume scan in x-fastest order → the linear index `i` IS voxelIndex(x,y,z); read/write directly.
  for (let i = 0; i < data.length; i++) if (data[i] === air && !outside[i]) data[i] = color;
}

// ---- verbatim pre-optimization reference twins (goal 088 D16, locked by obj-perf.test.ts) -------

/**
 * Reference rasterizer, kept verbatim from before the scratch-scalar/hoisting optimization.
 * Produces byte-identical output to `trisToVolume`; solid fills go through `solidifyReference`
 * so the whole reference pipeline is pre-optimization.
 */
export function trisToVolumeReference(verts: V3[], tris: Tri[], opts: RasterOptions = {}): VoxelVolume {
  const res = Math.max(2, Math.floor(opts.resolution ?? 32));
  const fallback = opts.mapColorId ?? DEFAULT_MODEL_MAP_COLOR_ID;
  if (verts.length === 0 || tris.length === 0) throw new Error("empty mesh (need vertices + triangles)");

  const b = opts.bounds ?? meshBounds(verts);
  const extent = Math.max(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!, b.max[2]! - b.min[2]!) || 1;
  const scale = (res - 1) / extent;
  const grid = (v: V3): V3 => [(v[0]! - b.min[0]!) * scale, (v[1]! - b.min[1]!) * scale, (v[2]! - b.min[2]!) * scale];

  const vol = createVolume(res, res, res);
  for (let t = 0; t < tris.length; t++) {
    const [ia, ib, ic] = tris[t]!;
    if (!Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic)) continue;
    if (ia < 0 || ib < 0 || ic < 0 || ia >= verts.length || ib >= verts.length || ic >= verts.length) continue;
    const color = opts.colorOf?.(t) ?? fallback;
    const a = grid(verts[ia]!);
    const bb = grid(verts[ib]!);
    const c = grid(verts[ic]!);
    const dist = (p: V3, q: V3) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const n = Math.max(2, Math.ceil(Math.max(dist(a, bb), dist(a, c), dist(bb, c))) * 2);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const uu = i / n;
        const w = j / n;
        const s = 1 - uu - w;
        setVoxel(
          vol,
          Math.round(a[0]! * s + bb[0]! * uu + c[0]! * w),
          Math.round(a[1]! * s + bb[1]! * uu + c[1]! * w),
          Math.round(a[2]! * s + bb[2]! * uu + c[2]! * w),
          color,
        );
      }
    }
  }
  if (opts.solid) solidifyReference(vol, fallback);
  return vol;
}

/**
 * Reference flood-fill, kept verbatim from before the Int32Array-stack/boundary-plane-seed
 * optimization. Produces byte-identical output to `solidify`.
 */
export function solidifyReference(vol: VoxelVolume, color: number): void {
  const { sx, sy, sz } = vol;
  const data = vol.data;
  const outside = new Uint8Array(sx * sy * sz);
  const at = (x: number, y: number, z: number) => (z * sy + y) * sx + x; // == voxelIndex
  const stack: number[] = [];
  const pushIfOpen = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    const i = at(x, y, z);
    if (outside[i] || data[i] !== EMPTY) return; // in bounds here → read backing array directly
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
  // full-volume scan in x-fastest order → the linear index `i` IS at(x,y,z); read/write directly.
  for (let i = 0; i < data.length; i++) if (data[i] === EMPTY && !outside[i]) data[i] = color;
}
