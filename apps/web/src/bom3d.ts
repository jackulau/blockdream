// Pure, DOM-free bill-of-materials aggregation for a voxel volume - the 3D counterpart of
// blockart-core's renderBom counts. Counts voxels per map-colour id (EMPTY excluded), sorted
// by count descending; the caller resolves ids to display info + markup.

import { EMPTY, type VoxelVolume } from "@blockdream/voxel";

export interface Bom3dRow {
  /** mapColorId of the voxels (resolve display info via safeBlockInfo / resolveBlock). */
  id: number;
  count: number;
  /** Share of all SOLID voxels, 0..100. */
  pct: number;
}

/**
 * Count solid voxels by id in one volume (the built solid - what `setup` places).
 *
 * Optimized form of volumeBomReference (identical output, locked by bom3d.test.ts): ids are bytes,
 * so a direct-indexed Int32Array(256) tally + an indexed for loop replace the iterator walk with a
 * Map get/set per solid voxel. The comparator is a total order over unique ids (count desc, then id
 * asc), so building rows in id order instead of first-encounter order cannot change the output.
 */
export function volumeBom(v: VoxelVolume): Bom3dRow[] {
  const tally = new Int32Array(256);
  const data = v.data;
  const AIR = EMPTY; // local alias: keeps the hot loop reading a register, not a module binding
  let total = 0;
  for (let i = 0; i < data.length; i++) {
    const cell = data[i]!;
    if (cell === AIR) continue;
    tally[cell] = tally[cell]! + 1;
    total++;
  }
  const rows: Bom3dRow[] = [];
  for (let id = 0; id < 256; id++) {
    const count = tally[id]!;
    if (count > 0) rows.push({ id, count, pct: (100 * count) / total });
  }
  return rows.sort((a, b) => b.count - a.count || a.id - b.id);
}

/** RETAINED REFERENCE (the original Map-tally volumeBom, verbatim) - the identity oracle. */
export function volumeBomReference(v: VoxelVolume): Bom3dRow[] {
  const counts = new Map<number, number>();
  let total = 0;
  for (const cell of v.data) {
    if (cell === EMPTY) continue;
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
    total++;
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count, pct: total > 0 ? (100 * count) / total : 0 }))
    .sort((a, b) => b.count - a.count || a.id - b.id);
}
