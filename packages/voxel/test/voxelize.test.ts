import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
import { imageToVolume } from "../src/voxelize";
import { getVoxel, countSolid, EMPTY } from "../src/volume";

function frame(width: number, height: number, ids: number[]): QuantizedFrame {
  return { width, height, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) };
}

describe("imageToVolume", () => {
  it("flat mode extrudes a slab of the given depth (image row 0 at top)", () => {
    const f = frame(2, 2, [1, 2, 3, 4]); // [[1,2],[3,4]]
    const v = imageToVolume(f, { mode: "flat", depth: 2 });
    expect([v.sx, v.sy, v.sz]).toEqual([2, 2, 2]);
    expect(countSolid(v)).toBe(2 * 2 * 2);
    // image (0,0)=1 is top-left → world y = height-1 = 1
    expect(getVoxel(v, 0, 1, 0)).toBe(1);
    expect(getVoxel(v, 0, 1, 1)).toBe(1); // extruded through depth
    expect(getVoxel(v, 1, 0, 0)).toBe(4); // image (1,1)=4 → bottom-right
  });

  it("heightmap mode extrudes columns by per-cell height", () => {
    const f = frame(2, 1, [1, 4]);
    const v = imageToVolume(f, { mode: "heightmap", maxHeight: 4, heightOf: (id) => id / 4 });
    expect([v.sx, v.sy, v.sz]).toEqual([2, 4, 1]);
    // id 1 → height round(0.25*4)=1 ; id 4 → height 4
    expect(countSolid(v)).toBe(1 + 4);
    expect(getVoxel(v, 0, 0, 0)).toBe(1);
    expect(getVoxel(v, 0, 1, 0)).toBe(EMPTY); // short column
    expect(getVoxel(v, 1, 3, 0)).toBe(4); // top of the tall column
  });
});
