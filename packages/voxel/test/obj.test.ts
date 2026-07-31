import { describe, it, expect } from "vitest";
import { objToVolume, parseObj, trisToVolume, DEFAULT_MODEL_MAP_COLOR_ID, type V3, type Tri } from "../src/obj";
import { gltfToFrames } from "../src/gltf";
import { getVoxel, countSolid, EMPTY, type VoxelVolume } from "../src/volume";

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

/** The single id every solid voxel carries (fails the test if the volume mixes ids or is empty). */
function soleSolidId(v: VoxelVolume): number {
  const ids = new Set<number>();
  for (let i = 0; i < v.data.length; i++) if (v.data[i] !== EMPTY) ids.add(v.data[i]!);
  expect(ids.size).toBe(1);
  return [...ids][0]!;
}

/** Minimal static glTF: one uncoloured triangle (no COLOR_0, no material), embedded buffer. */
function triangleGltf(): object {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 2, 4, 2]);
  const b64 = Buffer.from(new Uint8Array(positions.buffer)).toString("base64");
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
  };
}

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

  it("uncoloured mesh defaults to a placeable NON-AIR id on every solid voxel (0 = air downstream)", () => {
    // map colour 0 is the downstream air sentinel (emit-commands AIR_MAP_COLOR_ID): the old
    // `?? 0` default made an uncoloured mesh voxelize to id 0 everywhere and emit a 100% air pack.
    expect(DEFAULT_MODEL_MAP_COLOR_ID).not.toBe(0);
    expect(DEFAULT_MODEL_MAP_COLOR_ID).not.toBe(EMPTY);
    expect(DEFAULT_MODEL_MAP_COLOR_ID % 4).toBe(2); // canonical full shade (baseId*4 + 2) the solid resolver maps
    const shell = objToVolume(CUBE, { resolution: 8 });
    expect(soleSolidId(shell)).toBe(DEFAULT_MODEL_MAP_COLOR_ID);
    // solid:true fills the interior with the SAME non-air default
    const solid = objToVolume(CUBE, { resolution: 8, solid: true });
    expect(soleSolidId(solid)).toBe(DEFAULT_MODEL_MAP_COLOR_ID);
    expect(getVoxel(solid, 4, 4, 4)).toBe(DEFAULT_MODEL_MAP_COLOR_ID);
  });

  it("an explicit mapColorId still wins over the default (coloured behavior unchanged)", () => {
    const v = objToVolume(CUBE, { resolution: 8, mapColorId: 5, solid: true });
    expect(soleSolidId(v)).toBe(5);
  });

  it("matchColor on a vertex-coloured mesh still drives per-triangle ids (unchanged by the default)", () => {
    // pure red cube via the .obj vertex-color extension; matchColor maps red -> 37
    const red = CUBE.replace(/^v (.+)$/gm, "v $1 1 0 0");
    const v = objToVolume(red, { resolution: 8, matchColor: (r, g, b) => (r > 200 && g < 50 && b < 50 ? 37 : 99) });
    expect(soleSolidId(v)).toBe(37);
  });

  it("gltf path: colorless geometry gets the same non-air default; explicit mapColorId wins", () => {
    const [def] = gltfToFrames(triangleGltf(), { resolution: 12, solid: false });
    expect(countSolid(def!)).toBeGreaterThan(0);
    expect(soleSolidId(def!)).toBe(DEFAULT_MODEL_MAP_COLOR_ID);
    const [explicit] = gltfToFrames(triangleGltf(), { resolution: 12, solid: false, mapColorId: 5 });
    expect(soleSolidId(explicit!)).toBe(5);
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
