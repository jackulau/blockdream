import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { buildVoxelMcStructure, readMcStructure } from "../src/mcstructure";

const blockFor = (id: number) => ({ name: `minecraft:c${id}` });

describe("buildVoxelMcStructure (real 3D)", () => {
  it("emits a depth>1 structure that round-trips with correct size and blocks", () => {
    const v = createVolume(2, 2, 3); // W=2 H=2 D=3 - real 3D
    setVoxel(v, 0, 0, 0, 7);
    setVoxel(v, 1, 1, 2, 9);
    const buf = buildVoxelMcStructure(v, blockFor);
    const parsed = readMcStructure(buf);
    expect(parsed.size).toEqual([2, 2, 3]);
    // Bedrock index order: idx = (x*H + y)*D + z
    const idxAt = (x: number, y: number, z: number) => (x * 2 + y) * 3 + z;
    const air = parsed.blockNames.indexOf("minecraft:air");
    const c7 = parsed.blockNames.indexOf("minecraft:c7");
    const c9 = parsed.blockNames.indexOf("minecraft:c9");
    expect(c7).toBeGreaterThanOrEqual(0);
    expect(c9).toBeGreaterThanOrEqual(0);
    expect(parsed.indices[idxAt(0, 0, 0)]).toBe(c7);
    expect(parsed.indices[idxAt(1, 1, 2)]).toBe(c9);
    expect(parsed.indices[idxAt(1, 0, 0)]).toBe(air); // empty → air
    expect(parsed.blockNames).toContain("minecraft:air");
  });

  it("a larger structure round-trips EVERY index (exercises the IntList Int32Array bulk-copy path)", () => {
    const W = 16, H = 16, D = 8;
    const v = createVolume(W, H, D);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
      if ((x + y + z) % 3 === 0) setVoxel(v, x, y, z, ((x + y + z) % 5) + 1);
    }
    const parsed = readMcStructure(buildVoxelMcStructure(v, blockFor));
    expect(parsed.size).toEqual([W, H, D]);
    const idxAt = (x: number, y: number, z: number) => (x * H + y) * D + z;
    const air = parsed.blockNames.indexOf("minecraft:air");
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
      const expected = (x + y + z) % 3 === 0 ? parsed.blockNames.indexOf(`minecraft:c${((x + y + z) % 5) + 1}`) : air;
      expect(parsed.indices[idxAt(x, y, z)]).toBe(expected); // every cell survives the bulk-copy round-trip
    }
  });
});
