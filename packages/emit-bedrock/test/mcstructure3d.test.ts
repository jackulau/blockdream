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

  it("two distinct ids resolving to the SAME block share ONE palette entry (by-id cache dedups via intern)", () => {
    // The per-id palette-index cache must still route through `intern` (block-key dedup), or two
    // ids mapping to one block would create duplicate palette entries / wrong indices. Place id 1
    // and id 2 (both → minecraft:stone) plus id 3 (→ minecraft:dirt) and assert exactly one stone.
    const sameBlock = (id: number) => (id === 3 ? { name: "minecraft:dirt" } : { name: "minecraft:stone" });
    const v = createVolume(3, 1, 1);
    setVoxel(v, 0, 0, 0, 1); // stone (first appearance)
    setVoxel(v, 1, 0, 0, 2); // stone via a DIFFERENT id → must reuse the same palette entry
    setVoxel(v, 2, 0, 0, 3); // dirt
    const parsed = readMcStructure(buildVoxelMcStructure(v, sameBlock));
    const stoneEntries = parsed.blockNames.filter((n) => n === "minecraft:stone");
    expect(stoneEntries.length).toBe(1); // ONE shared entry, not one per id
    const idxAt = (x: number) => x; // H=D=1 → idx = x
    const stone = parsed.blockNames.indexOf("minecraft:stone");
    const dirt = parsed.blockNames.indexOf("minecraft:dirt");
    expect(parsed.indices[idxAt(0)]).toBe(stone);
    expect(parsed.indices[idxAt(1)]).toBe(stone); // id 2 → same stone index as id 1
    expect(parsed.indices[idxAt(2)]).toBe(dirt);
  });

  it("same block name with DIFFERENT states stays distinct (states are part of the palette key)", () => {
    const withStates = (id: number) => ({ name: "minecraft:note_block", states: { note: String(id) } });
    const v = createVolume(2, 1, 1);
    setVoxel(v, 0, 0, 0, 4);
    setVoxel(v, 1, 0, 0, 5); // same name, different `note` state → a second palette entry
    const parsed = readMcStructure(buildVoxelMcStructure(v, withStates));
    const noteEntries = parsed.blockNames.filter((n) => n === "minecraft:note_block");
    expect(noteEntries.length).toBe(2); // two distinct states → two entries
    expect(parsed.indices[0]).not.toBe(parsed.indices[1]);
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
