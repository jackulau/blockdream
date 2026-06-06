import { describe, it, expect } from "vitest";
import { objToVolume, parseObj } from "../src/obj";
import { getVoxel, countSolid, EMPTY } from "../src/volume";

// unit cube (8 verts, 6 quad faces → fan-triangulated)
const CUBE = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3 4
f 5 6 7 8
f 1 2 6 5
f 4 3 7 8
f 1 4 8 5
f 2 3 7 6
`;

describe("objToVolume", () => {
  it("parses verts + fan-triangulates quad faces", () => {
    const { verts, tris } = parseObj(CUBE);
    expect(verts.length).toBe(8);
    expect(tris.length).toBe(12); // 6 quads × 2 tris
  });

  it("voxelizes a cube into a hollow shell at the target resolution", () => {
    const v = objToVolume(CUBE, { resolution: 8, mapColorId: 5 });
    expect([v.sx, v.sy, v.sz]).toEqual([8, 8, 8]);
    expect(countSolid(v)).toBeGreaterThan(0);
    expect(getVoxel(v, 0, 0, 0)).toBe(5); // corner on the surface
    expect(getVoxel(v, 7, 7, 7)).toBe(5); // opposite corner
    expect(getVoxel(v, 4, 4, 0)).toBe(5); // interior of the z=0 face
    expect(getVoxel(v, 4, 4, 4)).toBe(EMPTY); // hollow centre (shell only)
  });

  it("throws on an empty/invalid .obj", () => {
    expect(() => objToVolume("# nothing here")).toThrow();
  });
});
