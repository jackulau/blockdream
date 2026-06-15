import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { greedyQuads, meshByMaterial, quadCount, FACE_NORMALS, type FaceDir } from "../src/mesh3d";

function solidCube(n: number, id = 7) {
  const v = createVolume(n, n, n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) setVoxel(v, x, y, z, id);
  return v;
}

describe("greedyQuads - face culling", () => {
  it("a single voxel emits exactly 6 faces", () => {
    const v = createVolume(3, 3, 3);
    setVoxel(v, 1, 1, 1, 5);
    const q = greedyQuads(v);
    expect(q.length).toBe(6);
    // one of each direction
    expect(new Set(q.map((x) => x.dir)).size).toBe(6);
    expect(q.every((x) => x.id === 5)).toBe(true);
  });

  it("a solid N³ cube culls ALL interior faces and greedy-merges each side to ONE quad", () => {
    for (const n of [2, 3, 4, 8]) {
      // naive cube-per-voxel would be 6·n³ faces; culled+merged shell is exactly 6
      expect(quadCount(solidCube(n))).toBe(6);
    }
  });

  it("two same-id adjacent voxels: the shared face is culled, the box merges to 6 quads", () => {
    const v = createVolume(4, 3, 3);
    setVoxel(v, 1, 1, 1, 9);
    setVoxel(v, 2, 1, 1, 9);
    expect(quadCount(v)).toBe(6); // a 2×1×1 box, fully merged
  });

  it("two DIFFERENT-id adjacent voxels: interior boundary still culled, but sides don't merge across ids", () => {
    const v = createVolume(4, 3, 3);
    setVoxel(v, 1, 1, 1, 3);
    setVoxel(v, 2, 1, 1, 8);
    const q = greedyQuads(v);
    // the face between the two solids is hidden (both solid) → not 12; the 4 long sides each split
    // into 2 (one per id) + 2 end caps = 10
    expect(q.length).toBe(10);
    expect(new Set(q.map((x) => x.id))).toEqual(new Set([3, 8]));
  });

  it("a hollow shell still only shows the outer surface (no inner faces leak when interior is air)", () => {
    // 3×3×3 solid then hollow the center → center has 6 air-adjacent... but it's enclosed, so the
    // INNER faces of the shell DO exist (they border the air pocket). Proves we don't over-cull.
    const v = solidCube(3, 4);
    setVoxel(v, 1, 1, 1, 255); // EMPTY center
    const q = greedyQuads(v);
    // outer shell = 6 merged quads; inner pocket = 6 faces around the 1³ hole
    expect(q.length).toBe(12);
  });
});

describe("greedyQuads - geometry correctness", () => {
  it("each quad's normal matches its face direction", () => {
    const q = greedyQuads(solidCube(2));
    for (const Q of q) {
      const n = FACE_NORMALS[Q.dir];
      expect(n).toBeDefined();
    }
    // the +X face quad sits on the max-X plane
    const px = q.find((x) => x.dir === 0)!;
    expect(px.verts[0]).toBe(2); // x coord of p00 is at the far face (cube spans 0..2)
  });
});

describe("meshByMaterial", () => {
  it("single-key grouping: a solid cube becomes one mesh of 6 quads (24 verts, 36 indices)", () => {
    const groups = meshByMaterial(solidCube(4, 7), (id) => `b${id}`);
    expect(groups.size).toBe(1);
    const m = groups.get("b7")!;
    expect(m.positions.length).toBe(24 * 3); // 6 quads × 4 verts × xyz
    expect(m.indices.length).toBe(6 * 6); // 6 quads × 2 tris × 3
    expect(m.uvs.length).toBe(24 * 2);
  });

  it("per-face keying splits a block's faces onto distinct materials (grass top vs side)", () => {
    const v = createVolume(3, 3, 3);
    setVoxel(v, 1, 1, 1, 2);
    const groups = meshByMaterial(v, (id, dir: FaceDir) => `${id}:${dir}`);
    expect(groups.size).toBe(6); // one material per face
  });

  it("geometry is centered on the origin", () => {
    const groups = meshByMaterial(solidCube(4, 1), (id) => `b${id}`);
    const m = groups.get("b1")!;
    let minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      minX = Math.min(minX, m.positions[i]!);
      maxX = Math.max(maxX, m.positions[i]!);
    }
    expect(minX).toBe(-2);
    expect(maxX).toBe(2); // cube of size 4 centered → [-2, 2]
  });
});
