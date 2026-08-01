// Greedy voxel mesher. The old viewer drew one full cube per voxel (a BoxGeometry instance
// each), so a solid N³ build spawned N³ cubes - including the fully-buried interior ones that
// can never be seen - and every one of the 6 faces of every cube, most of them hidden behind a
// neighbour. This mesher does what real voxel engines do:
//   1. FACE CULLING - emit a face only where a solid voxel borders air (or the volume edge), so
//      interior/occluded faces vanish. An N³ solid drops from 6·N³ faces to ~6·N² shell faces.
//   2. GREEDY MERGING - within each face plane, merge coplanar same-block faces into the largest
//      possible rectangle (one quad covering W×H cells, UV-tiled so each cell still shows a tile).
// The output is plain typed-array geometry grouped by a caller-chosen material key, so a block can
// carry DIFFERENT textures per face (grass top/side/bottom, log end-grain) by keying on the face.
// Pure (no three.js) → unit-testable in node.
//
// This is the HOT path of the 3D preview (viewer3d rAF → showFrame → buildGroup → meshByMaterial):
// long clips overflow the group cache, so every displayed frame re-meshes. The mesher therefore
// runs on precomputed linear strides into v.data (no per-cell boxed `x[d]` index arrays, no
// bounds-checked getVoxel calls) and meshByMaterial writes straight into exact-size typed arrays
// (no number[] push accumulation, no per-quad temp arrays). The original implementations are kept
// verbatim below as greedyQuadsReference / meshByMaterialReference, and mesh3d-perf.test.ts locks
// the optimized pair byte-identical to them.

import { EMPTY, getVoxel, type VoxelVolume } from "@blockdream/voxel";

/** Face directions: +X, -X, +Y, -Y, +Z, -Z. */
export type FaceDir = 0 | 1 | 2 | 3 | 4 | 5;
export const FACE_NAMES = ["px", "nx", "py", "ny", "pz", "nz"] as const;
export const FACE_NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export interface Quad {
  id: number; // mapColorId of the block
  dir: FaceDir;
  /** 4 corner positions (p00,p10,p11,p01), flattened xyz → 12 numbers, in voxel space. */
  verts: [number, number, number, number, number, number, number, number, number, number, number, number];
  /** UVs for the 4 corners, tiled to the merged W×H so each cell shows one texture tile. */
  uv: [number, number, number, number, number, number, number, number];
  /** true when the winding must be reversed so the normal faces outward (negative-facing planes). */
  reversed: boolean;
}

/**
 * Greedy-mesh a volume into culled, merged quads. One quad may span many cells.
 * Algorithm: the classic per-axis sweep - for each axis and each slice boundary, build a 2D mask
 * of visible faces (signed by block id + orientation), then merge equal-value rectangles.
 *
 * Optimized form of greedyQuadsReference (byte-identical output, locked by mesh3d-perf.test.ts):
 * the mask is built by walking v.data with per-axis linear strides and incremental offsets. The
 * only coordinate that can leave the volume is the sweep axis one (x[d] = -1 at the front boundary,
 * x[d]+1 = dd at the back boundary), and getVoxel returns EMPTY exactly there, so the per-slice
 * hasA/hasB guards reproduce its out-of-range semantics without any per-cell bounds check.
 */
export function greedyQuads(v: VoxelVolume): Quad[] {
  const dims = [v.sx, v.sy, v.sz];
  // linear stride of each axis in v.data (index order is x-fastest then y then z)
  const strides = [1, v.sx, v.sx * v.sy];
  const data = v.data;
  // local alias: keeps the per-cell hot loop reading a register, not the imported module binding
  // (module runners like vite-node turn imported-binding reads into namespace property lookups)
  const AIR = EMPTY;
  const quads: Quad[] = [];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const w = (d + 2) % 3;
    const du = dims[u]!;
    const dw = dims[w]!;
    const dd = dims[d]!;
    const sd = strides[d]!;
    const su = strides[u]!;
    const sw = strides[w]!;
    // mask value encoding: 0 = no face; (id+1) = face on the +d side; -(id+1) = face on the -d side.
    const mask = new Int32Array(du * dw);

    for (let xd = -1; xd < dd; ) {
      const hasA = xd >= 0; // cell on the -d side of this slice boundary is inside the volume
      const hasB = xd < dd - 1; // cell on the +d side is inside the volume
      const sliceBase = xd * sd;
      let n = 0;
      for (let xw = 0; xw < dw; xw++) {
        let off = sliceBase + xw * sw;
        for (let xu = 0; xu < du; xu++) {
          const a = hasA ? data[off]! : AIR;
          const b = hasB ? data[off + sd]! : AIR;
          if (a !== AIR && b === AIR) mask[n] = a + 1; // +d face of cell a
          else if (b !== AIR && a === AIR) mask[n] = -(b + 1); // -d face of cell b
          else mask[n] = 0; // both solid (interior) or both air → no face
          n++;
          off += su;
        }
      }
      xd++;

      // greedy-merge the mask into rectangles
      n = 0;
      for (let j = 0; j < dw; j++) {
        for (let i = 0; i < du; ) {
          const m = mask[n]!;
          if (m === 0) {
            i++;
            n++;
            continue;
          }
          // width: extend along u while equal
          let wq = 1;
          while (i + wq < du && mask[n + wq] === m) wq++;
          // height: extend along w while the whole row matches
          let hq = 1;
          outer: while (j + hq < dw) {
            for (let k = 0; k < wq; k++) {
              if (mask[n + k + hq * du] !== m) break outer;
            }
            hq++;
          }
          // emit the quad: base sits on the slice boundary plane at (d=xd, u=i, w=j); the quad
          // spans wq along u and hq along w. Components written directly (no temp vectors).
          const id = Math.abs(m) - 1;
          const positive = m > 0;
          let b0 = 0;
          let b1 = 0;
          let b2 = 0;
          let e0 = 0; // wq along axis u
          let e1 = 0;
          let e2 = 0;
          let f0 = 0; // hq along axis w
          let f1 = 0;
          let f2 = 0;
          if (d === 0) {
            // u = 1, w = 2
            b0 = xd;
            b1 = i;
            b2 = j;
            e1 = wq;
            f2 = hq;
          } else if (d === 1) {
            // u = 2, w = 0
            b1 = xd;
            b2 = i;
            b0 = j;
            e2 = wq;
            f0 = hq;
          } else {
            // u = 0, w = 1
            b2 = xd;
            b0 = i;
            b1 = j;
            e0 = wq;
            f1 = hq;
          }
          const dir = ((d * 2) + (positive ? 0 : 1)) as FaceDir;
          quads.push({
            id,
            dir,
            // p00, p10 (= p00 + u-extent), p11 (= p00 + both), p01 (= p00 + w-extent)
            verts: [
              b0,
              b1,
              b2,
              b0 + e0,
              b1 + e1,
              b2 + e2,
              b0 + e0 + f0,
              b1 + e1 + f1,
              b2 + e2 + f2,
              b0 + f0,
              b1 + f1,
              b2 + f2,
            ] as Quad["verts"],
            uv: [0, 0, wq, 0, wq, hq, 0, hq],
            reversed: !positive,
          });
          // zero the consumed cells
          for (let hh = 0; hh < hq; hh++) for (let ww = 0; ww < wq; ww++) mask[n + ww + hh * du] = 0;
          i += wq;
          n += wq;
        }
      }
    }
  }
  return quads;
}

/**
 * Reference greedy mesher, kept verbatim from before the linear-stride optimization: builds the
 * mask through boxed `x[d]`-indexed coordinate arrays and two bounds-checked getVoxel calls per
 * cell. Retained ONLY as the byte-identity oracle for greedyQuads (locked by mesh3d-perf.test.ts).
 */
export function greedyQuadsReference(v: VoxelVolume): Quad[] {
  const dims = [v.sx, v.sy, v.sz];
  const quads: Quad[] = [];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const w = (d + 2) % 3;
    const du = dims[u]!;
    const dw = dims[w]!;
    const dd = dims[d]!;
    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;
    // mask value encoding: 0 = no face; (id+1) = face on the +d side; -(id+1) = face on the -d side.
    const mask = new Int32Array(du * dw);

    for (x[d] = -1; x[d]! < dd; ) {
      let n = 0;
      for (x[w] = 0; x[w]! < dw; x[w]!++) {
        for (x[u] = 0; x[u]! < du; x[u]!++) {
          const a = x[d]! >= 0 ? getVoxel(v, x[0]!, x[1]!, x[2]!) : EMPTY;
          const b = x[d]! < dd - 1 ? getVoxel(v, x[0]! + q[0]!, x[1]! + q[1]!, x[2]! + q[2]!) : EMPTY;
          if (a !== EMPTY && b === EMPTY) mask[n] = a + 1; // +d face of cell a
          else if (b !== EMPTY && a === EMPTY) mask[n] = -(b + 1); // -d face of cell b
          else mask[n] = 0; // both solid (interior) or both air → no face
          n++;
        }
      }
      x[d]!++;

      // greedy-merge the mask into rectangles
      n = 0;
      for (let j = 0; j < dw; j++) {
        for (let i = 0; i < du; ) {
          const m = mask[n]!;
          if (m === 0) {
            i++;
            n++;
            continue;
          }
          // width: extend along u while equal
          let wq = 1;
          while (i + wq < du && mask[n + wq] === m) wq++;
          // height: extend along w while the whole row matches
          let hq = 1;
          outer: while (j + hq < dw) {
            for (let k = 0; k < wq; k++) {
              if (mask[n + k + hq * du] !== m) break outer;
            }
            hq++;
          }
          // emit the quad
          const id = Math.abs(m) - 1;
          const positive = m > 0;
          const base = [0, 0, 0];
          base[d] = x[d]!; // the slice boundary plane
          base[u] = i;
          base[w] = j;
          const du3 = [0, 0, 0];
          du3[u] = wq;
          const dw3 = [0, 0, 0];
          dw3[w] = hq;
          const p00: [number, number, number] = [base[0]!, base[1]!, base[2]!];
          const p10: [number, number, number] = [base[0]! + du3[0]!, base[1]! + du3[1]!, base[2]! + du3[2]!];
          const p11: [number, number, number] = [
            base[0]! + du3[0]! + dw3[0]!,
            base[1]! + du3[1]! + dw3[1]!,
            base[2]! + du3[2]! + dw3[2]!,
          ];
          const p01: [number, number, number] = [base[0]! + dw3[0]!, base[1]! + dw3[1]!, base[2]! + dw3[2]!];
          const dir = ((d * 2) + (positive ? 0 : 1)) as FaceDir;
          quads.push({
            id,
            dir,
            verts: [...p00, ...p10, ...p11, ...p01] as Quad["verts"],
            uv: [0, 0, wq, 0, wq, hq, 0, hq],
            reversed: !positive,
          });
          // zero the consumed cells
          for (let hh = 0; hh < hq; hh++) for (let ww = 0; ww < wq; ww++) mask[n + ww + hh * du] = 0;
          i += wq;
          n += wq;
        }
      }
    }
  }
  return quads;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  id: number; // a representative block id for this group (for the color fallback)
}

/**
 * Group greedy quads into geometry buffers keyed by a caller-chosen material key. `keyOf(id, dir)`
 * lets the caller put each face on a different texture (per-face blocks) or collapse all faces of a
 * block onto one key (single texture). Geometry centered so the volume's middle sits at the origin.
 *
 * Optimized form of meshByMaterialReference (byte-identical output, locked by mesh3d-perf.test.ts):
 * pass 1 resolves each quad's key once into a dense integer SLOT (the only string-keyed Map work);
 * pass 2 writes every component directly into exact-size typed arrays, reaching its buffers by
 * indexing the slot arrays - no string-keyed Map.get per quad on the rAF fill loop. Keys enter the
 * output Map in first-encounter order, matching the reference accumulator's insertion order.
 */
export function meshByMaterial(
  v: VoxelVolume,
  keyOf: (id: number, dir: FaceDir) => string,
): Map<string, MeshData> {
  const quads = greedyQuads(v);
  const cx = v.sx / 2;
  const cy = v.sy / 2;
  const cz = v.sz / 2;
  // pass 1: key -> slot + count per material (keyOf called exactly once per quad, like the
  // reference); each quad records its material's integer slot so pass 2 never touches a string key
  const slotOf = new Map<string, number>();
  const slotKeys: string[] = [];
  const slotIds: number[] = [];
  const slotQuadCounts: number[] = [];
  const slots = new Int32Array(quads.length);
  for (let qi = 0; qi < quads.length; qi++) {
    const Q = quads[qi]!;
    const key = keyOf(Q.id, Q.dir);
    let s = slotOf.get(key);
    if (s === undefined) {
      s = slotKeys.length;
      slotOf.set(key, s);
      slotKeys.push(key);
      slotIds.push(Q.id);
      slotQuadCounts.push(0);
    }
    slotQuadCounts[s] = slotQuadCounts[s]! + 1;
    slots[qi] = s;
  }
  // allocate every buffer at its exact final size (slot order = first-encounter order)
  const out = new Map<string, MeshData>();
  const meshes: MeshData[] = new Array(slotKeys.length);
  const quadCursor = new Int32Array(slotKeys.length);
  for (let s = 0; s < slotKeys.length; s++) {
    const n = slotQuadCounts[s]!;
    const m: MeshData = {
      positions: new Float32Array(n * 12),
      normals: new Float32Array(n * 12),
      uvs: new Float32Array(n * 8),
      indices: new Uint32Array(n * 6),
      id: slotIds[s]!,
    };
    out.set(slotKeys[s]!, m);
    meshes[s] = m;
  }
  // pass 2: fill (4 corners centered, per-quad normals, UVs, two outward-wound triangles)
  for (let qi = 0; qi < quads.length; qi++) {
    const Q = quads[qi]!;
    const s = slots[qi]!;
    const m = meshes[s]!;
    const q = quadCursor[s]!;
    quadCursor[s] = q + 1;
    const verts = Q.verts;
    const uv = Q.uv;
    const nrm = FACE_NORMALS[Q.dir]!;
    const nx = nrm[0];
    const ny = nrm[1];
    const nz = nrm[2];
    const pos = m.positions;
    const nor = m.normals;
    const uvs = m.uvs;
    const idx = m.indices;
    const p = q * 12;
    pos[p] = verts[0] - cx;
    pos[p + 1] = verts[1] - cy;
    pos[p + 2] = verts[2] - cz;
    pos[p + 3] = verts[3] - cx;
    pos[p + 4] = verts[4] - cy;
    pos[p + 5] = verts[5] - cz;
    pos[p + 6] = verts[6] - cx;
    pos[p + 7] = verts[7] - cy;
    pos[p + 8] = verts[8] - cz;
    pos[p + 9] = verts[9] - cx;
    pos[p + 10] = verts[10] - cy;
    pos[p + 11] = verts[11] - cz;
    nor[p] = nx;
    nor[p + 1] = ny;
    nor[p + 2] = nz;
    nor[p + 3] = nx;
    nor[p + 4] = ny;
    nor[p + 5] = nz;
    nor[p + 6] = nx;
    nor[p + 7] = ny;
    nor[p + 8] = nz;
    nor[p + 9] = nx;
    nor[p + 10] = ny;
    nor[p + 11] = nz;
    const t = q * 8;
    uvs[t] = uv[0];
    uvs[t + 1] = uv[1];
    uvs[t + 2] = uv[2];
    uvs[t + 3] = uv[3];
    uvs[t + 4] = uv[4];
    uvs[t + 5] = uv[5];
    uvs[t + 6] = uv[6];
    uvs[t + 7] = uv[7];
    const i0 = q * 6;
    const v0 = q * 4;
    if (!Q.reversed) {
      idx[i0] = v0;
      idx[i0 + 1] = v0 + 1;
      idx[i0 + 2] = v0 + 2;
      idx[i0 + 3] = v0;
      idx[i0 + 4] = v0 + 2;
      idx[i0 + 5] = v0 + 3;
    } else {
      idx[i0] = v0;
      idx[i0 + 1] = v0 + 2;
      idx[i0 + 2] = v0 + 1;
      idx[i0 + 3] = v0;
      idx[i0 + 4] = v0 + 3;
      idx[i0 + 5] = v0 + 2;
    }
  }
  return out;
}

/**
 * Reference grouper, kept verbatim from before the typed-array optimization: accumulates number[]
 * via push, then copies into typed arrays. Runs on greedyQuadsReference so the whole reference
 * pipeline stays original. Retained ONLY as the byte-identity oracle for meshByMaterial (locked by
 * mesh3d-perf.test.ts).
 */
export function meshByMaterialReference(
  v: VoxelVolume,
  keyOf: (id: number, dir: FaceDir) => string,
): Map<string, MeshData> {
  const quads = greedyQuadsReference(v);
  const cx = v.sx / 2;
  const cy = v.sy / 2;
  const cz = v.sz / 2;
  // accumulate per key
  const acc = new Map<string, { pos: number[]; nor: number[]; uv: number[]; idx: number[]; id: number }>();
  for (const Q of quads) {
    const key = keyOf(Q.id, Q.dir);
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { pos: [], nor: [], uv: [], idx: [], id: Q.id }));
    const nrm = FACE_NORMALS[Q.dir]!;
    const v0 = a.pos.length / 3;
    // 4 corners, centered
    for (let c = 0; c < 4; c++) {
      a.pos.push(Q.verts[c * 3]! - cx, Q.verts[c * 3 + 1]! - cy, Q.verts[c * 3 + 2]! - cz);
      a.nor.push(nrm[0], nrm[1], nrm[2]);
      a.uv.push(Q.uv[c * 2]!, Q.uv[c * 2 + 1]!);
    }
    // two triangles, winding so the normal faces outward
    if (!Q.reversed) a.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    else a.idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
  }
  const out = new Map<string, MeshData>();
  for (const [key, a] of acc)
    out.set(key, {
      positions: new Float32Array(a.pos),
      normals: new Float32Array(a.nor),
      uvs: new Float32Array(a.uv),
      indices: new Uint32Array(a.idx),
      id: a.id,
    });
  return out;
}

/** Total quad count - handy for tests / perf logging. */
export function quadCount(v: VoxelVolume): number {
  return greedyQuads(v).length;
}
