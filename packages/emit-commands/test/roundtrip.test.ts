// "Is it good" round-trip: voxelize → emit a vanilla datapack (fill-batched) → SIMULATE the
// emitted setblock/fill commands → the reconstructed blocks must equal the intended volume,
// every animation frame, AND each frame's per-tick command count must stay within budget.

import { describe, it, expect } from "vitest";
import { createVolume, getVoxel, setVoxel, EMPTY, type VoxelVolume } from "@blockdream/voxel";
import { generateVoxelDatapack } from "../src/datapack3d";
import { fillBatch } from "../src/fill";

const BUDGET = 8000; // maxCommandsPerFunction (well under maxCommandChainLength 65536)
const resolveBlock = (id: number) => `minecraft:c${id}`;
const air = "minecraft:air";

// a small build with solid runs (so /fill batching engages) + a 2nd frame that changes some
function buildFrames(): VoxelVolume[] {
  const v0 = createVolume(16, 4, 1);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) setVoxel(v0, x, y, 0, x < 8 ? 1 : 2); // two solid halves
  const v1 = createVolume(16, 4, 1);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) setVoxel(v1, x, y, 0, x < 8 ? 2 : 1); // swapped
  return [v0, v1];
}

type Grid = Map<string, string>;
const at = (x: number, y: number, z: number) => `${x},${y},${z}`;

function applyLines(grid: Grid, lines: string[]): void {
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const t = l.split(/\s+/);
    if (t[0] === "setblock") grid.set(at(+t[1]!, +t[2]!, +t[3]!), t[4]!);
    else if (t[0] === "fill") {
      const [x1, y1, z1, x2, y2, z2, block] = [+t[1]!, +t[2]!, +t[3]!, +t[4]!, +t[5]!, +t[6]!, t[7]!];
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) grid.set(at(x, y, z), block);
    }
  }
}

function expectedGrid(v: VoxelVolume, o: { x: number; y: number; z: number }): Grid {
  const g: Grid = new Map();
  for (let z = 0; z < v.sz; z++)
    for (let y = 0; y < v.sy; y++)
      for (let x = 0; x < v.sx; x++) {
        const id = getVoxel(v, x, y, z);
        g.set(at(o.x + x, o.y + y, o.z + z), id === EMPTY ? air : resolveBlock(id));
      }
  return g;
}

function frameLines(pack: ReturnType<typeof generateVoxelDatapack>, i: number): string[] {
  return (pack.files.get(`data/blockdream/function/frames/${i}.mcfunction`) ?? "").split("\n");
}

describe("round-trip: emit → simulate → matches, within budget", () => {
  const origin = { x: 0, y: 64, z: 0 };
  const frames = buildFrames();
  const pack = generateVoxelDatapack(frames, resolveBlock, { origin, optimize: (cells, r) => fillBatch(cells, r) });

  it("reconstructs every animation frame exactly", () => {
    const grid: Grid = new Map();
    applyLines(grid, (pack.files.get("data/blockdream/function/setup.mcfunction") ?? "").split("\n")); // box clear
    for (let f = 0; f < frames.length; f++) {
      applyLines(grid, frameLines(pack, f)); // keyframe then deltas, cumulative
      const want = expectedGrid(frames[f]!, origin);
      for (const [k, v] of want) expect(grid.get(k)).toBe(v);
    }
  });

  it("stays within the per-tick command budget and fill-batches solid runs", () => {
    for (let f = 0; f < frames.length; f++) {
      const lines = frameLines(pack, f).filter((l) => /^\s*(setblock|fill)\b/.test(l));
      expect(lines.length).toBeLessThan(BUDGET);
    }
    // keyframe: 16×4 cells in two solid halves → /fill collapses each row-half → far < 64
    const kf = frameLines(pack, 0).filter((l) => /^\s*(setblock|fill)\b/.test(l));
    expect(kf.length).toBeLessThan(16 * 4); // fill-batched, not one setblock per cell
    expect(kf.length).toBe(8); // 4 rows × 2 halves = 8 /fill commands
  });
});
