// Pure-aggregation tests for the 3D bill-of-materials helper (DOM-free by design).
import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { volumeBom } from "../src/bom3d";

describe("volumeBom", () => {
  it("counts solid voxels per id, sorted by count desc, EMPTY excluded", () => {
    const v = createVolume(3, 3, 1); // 9 cells, all EMPTY initially
    setVoxel(v, 0, 0, 0, 10);
    setVoxel(v, 1, 0, 0, 10);
    setVoxel(v, 2, 0, 0, 10);
    setVoxel(v, 0, 1, 0, 42);
    setVoxel(v, 1, 1, 0, 42);
    setVoxel(v, 0, 2, 0, 7);
    const rows = volumeBom(v);
    expect(rows.map((r) => r.id)).toEqual([10, 42, 7]);
    expect(rows.map((r) => r.count)).toEqual([3, 2, 1]);
    expect(rows[0]!.pct).toBeCloseTo(50, 5); // 3 of 6 solid
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 5);
  });

  it("ties break by id ascending and an empty volume yields no rows", () => {
    const v = createVolume(2, 1, 1);
    expect(volumeBom(v)).toEqual([]);
    setVoxel(v, 0, 0, 0, 9);
    setVoxel(v, 1, 0, 0, 3);
    expect(volumeBom(v).map((r) => r.id)).toEqual([3, 9]);
  });
});
