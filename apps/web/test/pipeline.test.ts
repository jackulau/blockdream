// Full pipeline: voxelize / quantize → emit (in-browser generators) → zip → it's a valid,
// droppable datapack AND simulating its own commands reconstructs the intended blocks,
// within the per-tick budget. Plus .obj → voxelize → emit → valid zip.

import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { generateJavaDatapack, generateVoxelDatapack, fillBatch } from "@blockdream/emit-commands";
import { createVolume, setVoxel, getVoxel, EMPTY, objToVolume, type VoxelVolume } from "@blockdream/voxel";
import { zipDatapack } from "../src/datapack-export";

const BUDGET = 8000;
const resolveBlock = (id: number) => `minecraft:c${id}`;
const air = "minecraft:air";

type Grid = Map<string, string>;
const at = (x: number, y: number, z: number) => `${x},${y},${z}`;

function applyLines(grid: Grid, text: string): void {
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const t = l.split(/\s+/);
    if (t[0] === "setblock") grid.set(at(+t[1]!, +t[2]!, +t[3]!), t[4]!);
    else if (t[0] === "fill") {
      for (let x = +t[1]!; x <= +t[4]!; x++)
        for (let y = +t[2]!; y <= +t[5]!; y++) for (let z = +t[3]!; z <= +t[6]!; z++) grid.set(at(x, y, z), t[7]!);
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

describe("full pipeline", () => {
  it("2D image → emit → zip is a valid datapack", () => {
    const frame = { width: 4, height: 4, mapColorId: Uint8Array.from(Array.from({ length: 16 }, (_, i) => (i % 4) + 1)), paletteIndex: Int32Array.from(Array.from({ length: 16 }, (_, i) => (i % 4) + 1)) };
    const pack = generateJavaDatapack([frame], resolveBlock);
    const files = unzipSync(zipDatapack(pack.files));
    expect(strFromU8(files["pack.mcmeta"]!)).toContain("pack_format");
    expect(files["data/minecraft/tags/function/tick.json"]).toBeDefined();
    expect(Object.keys(files).some((k) => /frames\/0\.mcfunction$/.test(k))).toBe(true);
  });

  it("3D animation → emit (fill-batched) → zip → simulate reconstructs every frame, within budget", () => {
    const origin = { x: 0, y: 64, z: 0 };
    const v0 = createVolume(6, 2, 1);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) setVoxel(v0, x, y, 0, x < 3 ? 1 : 2);
    const v1 = createVolume(6, 2, 1);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) setVoxel(v1, x, y, 0, x < 3 ? 2 : 1);
    const frames = [v0, v1];

    const pack = generateVoxelDatapack(frames, resolveBlock, { origin, optimize: (c, r) => fillBatch(c, r) });
    const files = unzipSync(zipDatapack(pack.files));
    expect(strFromU8(files["pack.mcmeta"]!)).toContain("pack_format");

    // simulate: box-clear (setup) then each frame cumulatively
    const grid: Grid = new Map();
    applyLines(grid, strFromU8(files["data/blockdream/function/setup.mcfunction"]!));
    for (let f = 0; f < frames.length; f++) {
      const text = strFromU8(files[`data/blockdream/function/frames/${f}.mcfunction`]!);
      applyLines(grid, text);
      for (const [k, want] of expectedGrid(frames[f]!, origin)) expect(grid.get(k)).toBe(want);
      const cmds = text.split("\n").filter((l) => /^\s*(setblock|fill)\b/.test(l));
      expect(cmds.length).toBeLessThan(BUDGET);
    }
  });

  it(".obj → voxelize → emit → valid zip", () => {
    const cube = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 2 3 4\nf 5 6 7 8\nf 1 2 6 5\nf 4 3 7 8\nf 1 4 8 5\nf 2 3 7 6";
    const vol = objToVolume(cube, { resolution: 6, mapColorId: 5 });
    const pack = generateVoxelDatapack([vol], resolveBlock, { optimize: (c, r) => fillBatch(c, r) });
    const files = unzipSync(zipDatapack(pack.files));
    expect(strFromU8(files["pack.mcmeta"]!)).toContain("pack_format");
    expect(strFromU8(files["data/blockdream/function/frames/0.mcfunction"]!)).toMatch(/(setblock|fill)/);
  });
});
