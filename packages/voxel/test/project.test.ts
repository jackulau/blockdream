import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "../src/volume";
import { volumeToFrame } from "../src/project";

// goal 036 D8 (coverage) + locks the D5 air sentinel at the projection level: an EMPTY column must
// project to map-colour 0 (air), never base 0's block.
describe("volumeToFrame", () => {
  it("a fully-empty volume projects to all-air (mapColorId 0)", () => {
    const f = volumeToFrame(createVolume(3, 3, 2));
    expect([...f.mapColorId].every((c) => c === 0)).toBe(true);
  });

  it("solid voxels project to their id; empty columns stay air (0)", () => {
    const v = createVolume(2, 2, 2);
    setVoxel(v, 0, 0, 0, 6); // one solid column
    const f = volumeToFrame(v);
    expect([...f.mapColorId]).toContain(6); // the solid projects through
    expect([...f.mapColorId]).toContain(0); // the empty columns are air, not a block
    expect(f.width).toBe(2);
    expect(f.height).toBe(2);
  });

  it("takes the nearest solid voxel along Z", () => {
    const v = createVolume(1, 1, 3);
    setVoxel(v, 0, 0, 0, 10);
    setVoxel(v, 0, 0, 2, 20);
    expect(volumeToFrame(v).mapColorId[0]).toBe(10); // z=0 is nearest (scanned first)
  });
});
