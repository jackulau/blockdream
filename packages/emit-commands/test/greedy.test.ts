import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { greedyBoxes, fillBatch, type PlacedCell } from "../src/fill";
import { generateJavaDatapack } from "../src/datapack";

// ---- a tiny command interpreter: apply setblock/fill lines to a 3D grid ----
type Grid = Map<string, string>;
const gk = (x: number, y: number, z: number) => `${x},${y},${z}`;

function applyLines(lines: string[]): Grid {
  const grid: Grid = new Map();
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "setblock") {
      const [, x, y, z, block] = t;
      grid.set(gk(+x!, +y!, +z!), block!);
    } else if (t[0] === "fill") {
      const [, x1, y1, z1, x2, y2, z2, block] = t;
      const [ax, ay, az, bx, by, bz] = [+x1!, +y1!, +z1!, +x2!, +y2!, +z2!];
      for (let z = Math.min(az, bz); z <= Math.max(az, bz); z++)
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++)
          for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
            grid.set(gk(x, y, z), block!);
    } else {
      throw new Error(`unexpected command: ${line}`);
    }
  }
  return grid;
}

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

const BLOCKS = ["minecraft:white_concrete", "minecraft:black_concrete", "minecraft:red_concrete", "minecraft:blue_concrete"];
const resolve = (id: number) => BLOCKS[id % BLOCKS.length]!;

describe("greedyBoxes — maximal box merge", () => {
  it("collapses a solid 32×32 region into a single /fill (1024 cells → 1 command)", () => {
    const cells: PlacedCell[] = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) cells.push({ x, y, z: 0, mapColorId: 0 });
    const lines = greedyBoxes(cells, resolve);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^fill 0 0 0 31 31 0 minecraft:white_concrete replace$/);
  });

  it("collapses a solid 16³ volume into a single /fill (4096 cells → 1 command)", () => {
    const cells: PlacedCell[] = [];
    for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) cells.push({ x, y, z, mapColorId: 2 });
    const lines = greedyBoxes(cells, resolve);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("fill 0 0 0 15 15 15 minecraft:red_concrete replace");
  });

  it("is lossless: reconstruction equals the input cells for a pseudo-random field", () => {
    // deterministic PRNG (no Math.random) so the test is reproducible
    let s = 0x12345678;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const cells: PlacedCell[] = [];
    const want: Grid = new Map();
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++) {
          if (rnd() < 0.7) {
            const id = Math.floor(rnd() * 4);
            cells.push({ x, y, z, mapColorId: id });
            want.set(gk(x, y, z), resolve(id));
          }
        }
    const got = applyLines(greedyBoxes(cells, resolve));
    expect(got.size).toBe(want.size);
    for (const [k, v] of want) expect(got.get(k)).toBe(v);
  });

  it("never emits more commands than X-only fillBatch, and far fewer on flat fields", () => {
    // 40×40 with 4 solid quadrants → fillBatch makes ~40 rows×4; greedy makes 4 boxes
    const cells: PlacedCell[] = [];
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) {
        const id = (x < 20 ? 0 : 1) + (y < 20 ? 0 : 2);
        cells.push({ x, y, z: 0, mapColorId: id });
      }
    const greedy = greedyBoxes(cells, resolve).length;
    const xonly = fillBatch(cells, resolve).length;
    expect(greedy).toBeLessThanOrEqual(xonly);
    expect(greedy).toBe(4); // exactly one /fill per quadrant
    expect(xonly).toBeGreaterThan(greedy);
  });

  it("checkerboard cannot merge — degrades to one command per cell (no worse than unoptimized)", () => {
    const cells: PlacedCell[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) cells.push({ x, y, z: 0, mapColorId: (x + y) % 2 });
    const lines = greedyBoxes(cells, resolve);
    expect(lines.length).toBe(64);
    expect(lines.every((l) => l.startsWith("setblock"))).toBe(true);
  });
});

describe("generateJavaDatapack — optimized 2D output", () => {
  it("solid 32×32 keyframe is 1 command and reconstructs byte-identical", () => {
    const ids = Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => 0));
    const pack = generateJavaDatapack([frameFromIds(ids)], resolve, { origin: { x: 0, y: 64, z: 0 } });
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    const cmds = f0.split("\n").filter((l) => l.startsWith("setblock") || l.startsWith("fill"));
    expect(cmds.length).toBe(1);
    expect(pack.totalCommands).toBe(1);
    expect(pack.totalSetblocks).toBe(1024); // changed-cell count is unchanged
    // reconstruct: every world cell across the 32×32 wall is white_concrete
    const grid = applyLines(cmds);
    expect(grid.size).toBe(1024);
    for (const v of grid.values()) expect(v).toBe("minecraft:white_concrete");
  });

  it("optimized output emits far fewer commands than unoptimized on a flat image", () => {
    const ids = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, () => (y < 8 ? 0 : 1)));
    const frame = frameFromIds(ids);
    const opt = generateJavaDatapack([frame], resolve, { optimizeFills: true });
    const raw = generateJavaDatapack([frame], resolve, { optimizeFills: false });
    expect(opt.totalCommands!).toBeLessThan(raw.totalCommands!);
    expect(opt.totalCommands).toBe(2); // two solid horizontal bands → two /fills
    expect(raw.totalCommands).toBe(256);

    // both reconstruct to the same wall
    const optGrid = applyLines(opt.files.get("data/blockdream/function/frames/0.mcfunction")!.split("\n").filter((l) => /^(setblock|fill)/.test(l)));
    expect(optGrid.size).toBe(256);
  });
});
