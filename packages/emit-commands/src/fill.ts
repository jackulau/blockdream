// /fill run-batching — the core command-count optimizer. Vanilla `/fill` writes a whole
// cuboid in one command, so collapsing runs of consecutive same-block cells into `/fill`
// instead of one `/setblock` each massively cuts the per-tick command count (a solid 64-
// wide row → 1 command instead of 64). Works for 2D walls (z constant) and 3D volumes.

export interface PlacedCell {
  x: number;
  y: number;
  z: number;
  mapColorId: number;
}

const key = (y: number, z: number) => `${y}|${z}`;

/**
 * Collapse cells into command lines, batching contiguous same-block runs along X into
 * `/fill`. `resolve` maps a map-colour id to a block string (incl. air for cleared cells).
 * Runs of length ≥2 become `/fill`, singletons stay `/setblock`. Deterministic ordering
 * (z→y→x) so output is reproducible.
 */
export function fillBatch(cells: PlacedCell[], resolve: (mapColorId: number) => string): string[] {
  // group by (y,z) row, sorted by x
  const rows = new Map<string, PlacedCell[]>();
  for (const c of cells) {
    const k = key(c.y, c.z);
    let r = rows.get(k);
    if (!r) rows.set(k, (r = []));
    r.push(c);
  }
  const orderedKeys = [...rows.keys()].sort((a, b) => {
    const [ay, az] = a.split("|").map(Number) as [number, number];
    const [by, bz] = b.split("|").map(Number) as [number, number];
    return az - bz || ay - by;
  });

  const lines: string[] = [];
  for (const k of orderedKeys) {
    const row = rows.get(k)!.sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < row.length) {
      const start = row[i]!;
      const block = resolve(start.mapColorId);
      let j = i;
      // extend the run while x is contiguous and the resolved block matches
      while (j + 1 < row.length && row[j + 1]!.x === row[j]!.x + 1 && resolve(row[j + 1]!.mapColorId) === block) {
        j++;
      }
      const end = row[j]!;
      if (j > i) {
        lines.push(`fill ${start.x} ${start.y} ${start.z} ${end.x} ${end.y} ${end.z} ${block} replace`);
      } else {
        lines.push(`setblock ${start.x} ${start.y} ${start.z} ${block} replace`);
      }
      i = j + 1;
    }
  }
  return lines;
}

/** How many commands fillBatch would emit (for budget accounting). */
export function fillBatchCount(cells: PlacedCell[], resolve: (mapColorId: number) => string): number {
  return fillBatch(cells, resolve).length;
}
