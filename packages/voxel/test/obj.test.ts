import { describe, it, expect } from "vitest";
import { objToVolume, parseObj, trisToVolume, type V3, type Tri } from "../src/obj";
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

  it("throws on a malformed (non-numeric) vertex instead of producing NaN voxels", () => {
    expect(() => parseObj("v 0 0 0\nv nan x 1\nf 1 2 1")).toThrow(/malformed vertex/);
    expect(() => objToVolume("v 0 0 0\nv 1 oops 0\nv 0 1 1\nf 1 2 3")).toThrow(/malformed vertex/);
  });

  it("skips a malformed face row (f //1 //2 //3 → NaN indices) instead of crashing on verts[NaN]", () => {
    // parseInt("") = NaN; NaN sailed past the rasterizer's range guard (every comparison false)
    // and crashed at grid(verts[NaN]). The row is now dropped at parse time.
    const { tris } = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf //1 //2 //3");
    expect(tris.length).toBe(0);
    // a valid mesh plus one garbage face row still voxelizes
    const v = objToVolume(CUBE + "f //1 //2 //3\n", { resolution: 8, mapColorId: 5 });
    expect(countSolid(v)).toBeGreaterThan(0);
  });

  it("an .obj whose ONLY faces are malformed throws the clear empty error (not a NaN crash)", () => {
    expect(() => objToVolume("v 0 0 0\nv 1 0 0\nv 0 1 0\nf //1 //2 //3")).toThrow(/empty or invalid/);
  });

  it("trisToVolume skips non-finite/non-integer triangle indices (defense for non-parseObj callers)", () => {
    const verts: V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    const tris: Tri[] = [[NaN, 0, 1], [0, 1, 2]];
    const v = trisToVolume(verts, tris, { resolution: 4, mapColorId: 5 });
    expect(countSolid(v)).toBeGreaterThan(0); // the valid triangle rasterized; the NaN one skipped
  });

  it("solid:true fills the interior (no hollow centre)", () => {
    const hollow = objToVolume(CUBE, { resolution: 8, mapColorId: 5 });
    const solid = objToVolume(CUBE, { resolution: 8, mapColorId: 5, solid: true });
    expect(getVoxel(hollow, 4, 4, 4)).toBe(EMPTY); // shell only
    expect(getVoxel(solid, 4, 4, 4)).toBe(5); // interior filled
    expect(countSolid(solid)).toBeGreaterThan(countSolid(hollow));
    // boundary stays open (it's "outside", never filled)
    expect(getVoxel(solid, 0, 0, 0)).toBe(5); // corner is on the shell, so still solid
  });
});
