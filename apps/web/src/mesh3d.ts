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
 */
export function greedyQuads(v: VoxelVolume): Quad[] {
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
 */
export function meshByMaterial(
  v: VoxelVolume,
  keyOf: (id: number, dir: FaceDir) => string,
): Map<string, MeshData> {
  const quads = greedyQuads(v);
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
