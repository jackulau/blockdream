import { describe, it, expect } from "vitest";
import { createVolume, getVoxel, setVoxel, countSolid, forEachSolid, EMPTY, voxelIndex } from "../src/volume";

describe("VoxelVolume", () => {
  it("creates an all-air volume", () => {
    const v = createVolume(3, 4, 5);
    expect(v.data.length).toBe(60);
    expect(countSolid(v)).toBe(0);
    expect(getVoxel(v, 0, 0, 0)).toBe(EMPTY);
  });

  it("set/get round-trips and is bounds-safe", () => {
    const v = createVolume(4, 4, 4);
    setVoxel(v, 1, 2, 3, 7);
    expect(getVoxel(v, 1, 2, 3)).toBe(7);
    expect(voxelIndex(v, 1, 2, 3)).toBe(1 + 4 * (2 + 4 * 3));
    expect(getVoxel(v, -1, 0, 0)).toBe(EMPTY); // out of bounds → air
    setVoxel(v, 99, 99, 99, 5); // no-op, no throw
    expect(countSolid(v)).toBe(1);
  });

  it("forEachSolid visits only solid voxels in x→y→z order", () => {
    const v = createVolume(2, 2, 2);
    setVoxel(v, 0, 0, 0, 10);
    setVoxel(v, 1, 1, 1, 20);
    const seen: Array<[number, number, number, number]> = [];
    forEachSolid(v, (x, y, z, c) => seen.push([x, y, z, c]));
    expect(seen).toEqual([
      [0, 0, 0, 10],
      [1, 1, 1, 20],
    ]);
  });
});
