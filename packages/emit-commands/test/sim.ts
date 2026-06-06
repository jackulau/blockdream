// Shared command-pack simulator for round-trip tests. Executes a generated datapack /
// behavior-pack's frame functions — following `function` calls and applying setblock/fill —
// to RECONSTRUCT the in-world wall, then compares it to the source frames. This proves
// animation is byte-correct across editions, not merely structurally valid. Also includes
// a POOL simulator for the Bedrock Script addon (delta cells, no mcfunctions).
//
// Not a *.test.ts file, so vitest does not collect it as a suite.

export type Grid = Map<string, string>;
export const at = (x: number, y: number, z: number) => `${x},${y},${z}`;

function applyCmd(grid: Grid, t: string[]): void {
  if (t[0] === "setblock") {
    grid.set(at(+t[1]!, +t[2]!, +t[3]!), t[4]!);
  } else if (t[0] === "fill") {
    const [x1, y1, z1, x2, y2, z2, block] = [+t[1]!, +t[2]!, +t[3]!, +t[4]!, +t[5]!, +t[6]!, t[7]!];
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) grid.set(at(x, y, z), block);
  }
}

function refToPath(ref: string, edition: "java" | "bedrock"): string {
  if (edition === "java") {
    const [ns, ...rest] = ref.split(":");
    return `data/${ns}/function/${rest.join(":")}.mcfunction`;
  }
  return `functions/${ref}.mcfunction`;
}

/** Execute a function ref, recursing into nested `function` calls, applying block edits. */
export function runFunction(
  files: Map<string, string>,
  ref: string,
  edition: "java" | "bedrock",
  grid: Grid,
  depth = 0,
): void {
  if (depth > 64) throw new Error("function recursion too deep");
  const body = files.get(refToPath(ref, edition));
  if (body == null) throw new Error(`missing function file for ref ${ref}`);
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l.startsWith("$")) continue; // comments + macro dispatcher
    const t = l.split(/\s+/);
    if (t[0] === "setblock" || t[0] === "fill") applyCmd(grid, t);
    else if (t[0] === "function") runFunction(files, t[1]!, edition, grid, depth + 1);
    // execute / scoreboard / forceload / tickingarea — irrelevant to reconstructing geometry
  }
}

/**
 * Play frames 0..n-1 in order (keyframe then cumulative deltas) and snapshot the wall after
 * each. `setupRef` (optional) runs first — e.g. the 3D box-clear; 2D walls need none because
 * frame 0 is a full keyframe.
 */
export function playFrames(
  files: Map<string, string>,
  ns: string,
  edition: "java" | "bedrock",
  n: number,
  setupRef?: string,
): Grid[] {
  const grid: Grid = new Map();
  if (setupRef) runFunction(files, setupRef, edition, grid);
  const out: Grid[] = [];
  for (let i = 0; i < n; i++) {
    const ref = edition === "java" ? `${ns}:frames/${i}` : `${ns}/frames/${i}`;
    runFunction(files, ref, edition, grid);
    out.push(new Map(grid));
  }
  return out;
}

/** Expected wall for a quantized 2D frame (image row 0 → top of wall, +Z constant). */
export function expectedWall2D(
  frame: { width: number; height: number; mapColorId: Uint8Array },
  origin: { x: number; y: number; z: number },
  resolve: (id: number) => string,
): Grid {
  const g: Grid = new Map();
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      const id = frame.mapColorId[y * frame.width + x]!;
      g.set(at(origin.x + x, origin.y + (frame.height - 1 - y), origin.z), resolve(id));
    }
  return g;
}

/** Simulate the Bedrock Script addon POOL: apply each frame's [x,y,paletteIdx] delta cells. */
export function playPool(framesJsText: string): { grids: Grid[]; pool: any } {
  const m = framesJsText.match(/export const POOL = (\{[\s\S]*\});/);
  if (!m) throw new Error("no POOL found in frames.js");
  const pool = JSON.parse(m[1]!);
  const grid: Grid = new Map();
  const grids: Grid[] = [];
  for (let f = 0; f < pool.frames.length; f++) {
    for (const c of pool.frames[f] as Array<[number, number, number]>) {
      const block = pool.palette[c[2]];
      grid.set(at(pool.origin.x + c[0], pool.origin.y + (pool.height - 1 - c[1]), pool.origin.z), block);
    }
    grids.push(new Map(grid));
  }
  return { grids, pool };
}

/** Assert two grids are cell-for-cell identical. */
export function expectGridsEqual(got: Grid, want: Grid, expect: (v: unknown) => any): void {
  expect(got.size).toBe(want.size);
  for (const [k, v] of want) expect(got.get(k)).toBe(v);
}
