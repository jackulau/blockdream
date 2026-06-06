import { describe, it, expect } from "vitest";
import { createVolume, getVoxel, setVoxel, countSolid } from "../src/volume";
import { rotateY, spin } from "../src/spin";

function xLine(): ReturnType<typeof createVolume> {
  // a line of voxels along X at the centre Z plane of a 5×1×5 volume
  const v = createVolume(5, 1, 5);
  for (let x = 0; x < 5; x++) setVoxel(v, x, 0, 2, 9);
  return v;
}

describe("spin engine", () => {
  it("rotateY by 0 is the identity", () => {
    const v = xLine();
    const r = rotateY(v, 0);
    expect([...r.data]).toEqual([...v.data]);
  });

  it("a 90° turn maps an X-line to a Z-line at the centre (nearest-neighbour, exact)", () => {
    const r = rotateY(xLine(), Math.PI / 2);
    expect(countSolid(r)).toBe(5);
    for (let z = 0; z < 5; z++) expect(getVoxel(r, 2, 0, z)).toBe(9); // now a line along Z at x=2
    expect(getVoxel(r, 0, 0, 2)).toBe(255); // the old X-line endpoints are gone
  });

  it("spin returns nFrames, frame 0 is identity, and a full turn ≈ identity", () => {
    const v = xLine();
    const frames = spin(v, 8, "y");
    expect(frames.length).toBe(8);
    expect([...frames[0]!.data]).toEqual([...v.data]); // angle 0
    const full = rotateY(v, 2 * Math.PI);
    expect(countSolid(full)).toBe(countSolid(v));
  });
});
