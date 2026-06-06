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

const key3 = (x: number, y: number, z: number) => `${x}|${y}|${z}`;

/**
 * Greedy maximal-box merging — the strong optimizer. Where `fillBatch` only
 * collapses runs along X (a 64×64 solid → 64 `/fill`s), this grows each `/fill`
 * into the largest axis-aligned box of identical, present, not-yet-emitted cells
 * (a 64×64 solid → 1 `/fill`; a 64³ solid → 1). Lossless and deterministic:
 * every input cell is covered exactly once by exactly one box of its own block.
 *
 * Greedy meshing per seed cell (iteration order z→y→x): extend +X while the next
 * cell matches, then +Y while the whole X-run matches, then +Z while the whole
 * XY-rect matches. Cells already inside an emitted box are skipped. Boxes never
 * overlap, so applying the commands in order reconstructs the input exactly.
 *
 * `cells` carry WORLD coordinates (caller maps grid→world). `resolve` maps a
 * map-colour id to a block string (incl. air for cleared/transition cells).
 */
export function greedyBoxes(cells: PlacedCell[], resolve: (mapColorId: number) => string): string[] {
  if (cells.length === 0) return [];
  const blockAt = new Map<string, string>();
  for (const c of cells) blockAt.set(key3(c.x, c.y, c.z), resolve(c.mapColorId));
  const visited = new Set<string>();
  const ordered = [...cells].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);

  const matches = (x: number, y: number, z: number, block: string): boolean => {
    const k = key3(x, y, z);
    return blockAt.get(k) === block && !visited.has(k);
  };

  const lines: string[] = [];
  for (const c of ordered) {
    const k0 = key3(c.x, c.y, c.z);
    if (visited.has(k0)) continue;
    const block = blockAt.get(k0)!;
    const x0 = c.x, y0 = c.y, z0 = c.z;

    // extend +X
    let x1 = x0;
    while (matches(x1 + 1, y0, z0, block)) x1++;

    // extend +Y while the whole [x0..x1] row matches
    let y1 = y0;
    for (;;) {
      const ny = y1 + 1;
      let ok = true;
      for (let xx = x0; xx <= x1; xx++) if (!matches(xx, ny, z0, block)) { ok = false; break; }
      if (!ok) break;
      y1 = ny;
    }

    // extend +Z while the whole [x0..x1]×[y0..y1] rect matches
    let z1 = z0;
    for (;;) {
      const nz = z1 + 1;
      let ok = true;
      outer: for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++) if (!matches(xx, yy, nz, block)) { ok = false; break outer; }
      if (!ok) break;
      z1 = nz;
    }

    for (let zz = z0; zz <= z1; zz++)
      for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++) visited.add(key3(xx, yy, zz));

    if (x0 === x1 && y0 === y1 && z0 === z1) {
      lines.push(`setblock ${x0} ${y0} ${z0} ${block} replace`);
    } else {
      lines.push(`fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} ${block} replace`);
    }
  }
  return lines;
}

/** How many commands greedyBoxes would emit (for budget accounting). */
export function greedyBoxCount(cells: PlacedCell[], resolve: (mapColorId: number) => string): number {
  return greedyBoxes(cells, resolve).length;
}
