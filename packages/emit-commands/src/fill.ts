// /fill run-batching - the core command-count optimizer. Vanilla `/fill` writes a whole
// cuboid in one command, so collapsing runs of consecutive same-block cells into `/fill`
// instead of one `/setblock` each massively cuts the per-tick command count (a solid 64-
// wide row → 1 command instead of 64). Works for 2D walls (z constant) and 3D volumes.

import { fillBatch as fillBatchImpl } from "./fill-batch.mjs";

export interface PlacedCell {
  x: number;
  y: number;
  z: number;
  mapColorId: number;
}

/**
 * Collapse cells into command lines, batching contiguous same-block runs along X into
 * `/fill`. `resolve` maps a map-colour id to a block string (incl. air for cleared cells).
 * Runs of length ≥2 become `/fill`, singletons stay `/setblock`. Deterministic ordering
 * (z→y→x) so output is reproducible.
 *
 * The algorithm lives in `fill-batch.mjs` (single source) so the worker-thread pool
 * (emit-worker.mjs) and this typed entry can never drift. `greedyBoxes` below is the stronger
 * 3D box merge; this X-only pass is what the parallel pool uses.
 */
export function fillBatch(cells: PlacedCell[], resolve: (mapColorId: number) => string): string[] {
  return fillBatchImpl(cells, resolve);
}

/** How many commands fillBatch would emit (for budget accounting). */
export function fillBatchCount(cells: PlacedCell[], resolve: (mapColorId: number) => string): number {
  return fillBatch(cells, resolve).length;
}

/** Minecraft's hard `/fill` cap: a single fill may touch at most this many blocks, else the command
 *  is rejected at runtime ("Too many blocks in the specified area") and that region never builds. */
export const MAX_FILL_VOLUME = 32768;

/**
 * Emit one-or-more `fill` lines covering the box [x0..x1]×[y0..y1]×[z0..z1], each ≤ MAX_FILL_VOLUME
 * blocks. A box within the cap is a single `/fill`; an oversized box is halved along its longest axis
 * until every piece fits (a 64³ solid → 8 fills of 32768, not one rejected 262144 fill). The pieces
 * tile the box exactly (no overlap, no gap), so the result is identical to one giant fill.
 */
export function fillLines(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  block: string, mode: "replace" | "destroy" | "keep" | "hollow" | "outline" = "replace",
): string[] {
  const lines: string[] = [];
  const stack: [number, number, number, number, number, number][] = [[x0, y0, z0, x1, y1, z1]];
  while (stack.length) {
    const [ax, ay, az, bx, by, bz] = stack.pop()!;
    const dx = bx - ax + 1, dy = by - ay + 1, dz = bz - az + 1;
    if (dx * dy * dz <= MAX_FILL_VOLUME) {
      lines.push(`fill ${ax} ${ay} ${az} ${bx} ${by} ${bz} ${block} ${mode}`);
    } else if (dx >= dy && dx >= dz) {
      const m = (ax + bx) >> 1; stack.push([m + 1, ay, az, bx, by, bz], [ax, ay, az, m, by, bz]);
    } else if (dy >= dz) {
      const m = (ay + by) >> 1; stack.push([ax, m + 1, az, bx, by, bz], [ax, ay, az, bx, m, bz]);
    } else {
      const m = (az + bz) >> 1; stack.push([ax, ay, m + 1, bx, by, bz], [ax, ay, az, bx, by, m]);
    }
  }
  return lines;
}

const key3 = (x: number, y: number, z: number) => `${x}|${y}|${z}`;

/**
 * Greedy maximal-box merging - the strong optimizer. Where `fillBatch` only
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
      lines.push(...fillLines(x0, y0, z0, x1, y1, z1, block, "replace")); // split at the 32768 /fill cap
    }
  }
  return lines;
}

/** How many commands greedyBoxes would emit (for budget accounting). */
export function greedyBoxCount(cells: PlacedCell[], resolve: (mapColorId: number) => string): number {
  return greedyBoxes(cells, resolve).length;
}
