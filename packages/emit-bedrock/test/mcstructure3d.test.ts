import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { buildVoxelMcStructure, readMcStructure } from "../src/mcstructure";

const blockFor = (id: number) => ({ name: `minecraft:c${id}` });

describe("buildVoxelMcStructure (real 3D)", () => {
  it("emits a depth>1 structure that round-trips with correct size and blocks", () => {
    const v = createVolume(2, 2, 3); // W=2 H=2 D=3 — real 3D
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
});
