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

/** Count solid voxels by id in one volume (the built solid - what `setup` places). */
export function volumeBom(v: VoxelVolume): Bom3dRow[] {
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
