import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid, detectBackgroundMask, silhouetteDistance } from "../src/depth";
import { getVoxel, countSolid, EMPTY, forEachSolid } from "../src/volume";

function frame(width: number, height: number, ids: number[]): QuantizedFrame {
  return { width, height, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) };
}

// a centered square subject (id 5) on a background (id 0)
function squareOnBg(size: number, sub: number, bg = 0, fg = 5): QuantizedFrame {
  const ids = new Array(size * size).fill(bg);
  const lo = Math.floor((size - sub) / 2);
  for (let y = lo; y < lo + sub; y++) for (let x = lo; x < lo + sub; x++) ids[y * size + x] = fg;
  return frame(size, size, ids);
}

describe("detectBackgroundMask", () => {
  it("removes the border-connected background, keeps the subject", () => {
    const f = squareOnBg(8, 4);
    const mask = detectBackgroundMask(f); // 1 = background
    expect(mask[0]).toBe(1); // corner is background
    // a center cell is subject
    expect(mask[4 * 8 + 4]).toBe(0);
  });

  it("an all-one-colour image yields all background (no subject)", () => {
    const f = frame(4, 4, new Array(16).fill(3));
    const mask = detectBackgroundMask(f);
    expect(Array.from(mask).every((m) => m === 1)).toBe(true);
  });
});

describe("silhouetteDistance", () => {
  it("interior pixels are farther from the edge than rim pixels", () => {
    const f = squareOnBg(9, 5);
    const mask = new Uint8Array(81);
    const bg = detectBackgroundMask(f);
    for (let i = 0; i < 81; i++) mask[i] = bg[i] ? 0 : 1;
    const d = silhouetteDistance(mask, 9, 9);
    const center = d[4 * 9 + 4]!;
    const rim = d[2 * 9 + 4]!; // top rim of the 5x5 square (row 2)
    expect(center).toBeGreaterThan(rim);
    expect(rim).toBeGreaterThan(0);
  });
});

describe("imageToSolid", () => {
  it("isolates the subject — background pixels become air", () => {
    const f = squareOnBg(8, 4);
    const v = imageToSolid(f, { maxDepth: 8 });
    expect([v.sx, v.sy, v.sz]).toEqual([8, 8, 8]);
    // a corner column (background) is entirely empty across all z
    for (let z = 0; z < 8; z++) expect(getVoxel(v, 0, 0, z)).toBe(EMPTY);
    // the subject exists
    expect(countSolid(v)).toBeGreaterThan(0);
  });

  it("is centered + double-sided — the deepest part straddles BOTH halves of the depth axis", () => {
    const f = squareOnBg(16, 10);
    const maxDepth = 12;
    const v = imageToSolid(f, { maxDepth });
    const mid = (maxDepth - 1) / 2;
    let below = 0; // solid voxels in front half (z < mid)
    let above = 0; // solid voxels in back half (z > mid)
    forEachSolid(v, (_x, _y, z) => {
      if (z < mid) below++;
      else if (z > mid) above++;
    });
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
    // symmetric → front and back roughly balanced (not a one-sided slab)
    const ratio = below / above;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("reads as a real object from the side — the side silhouette is more than a 1-voxel sliver", () => {
    const f = squareOnBg(16, 12);
    const v = imageToSolid(f, { maxDepth: 12 });
    // project onto the X-Z plane (look from above): count distinct depths used in the center column
    const depthsAtCenterRow = new Set<number>();
    const cy = 8;
    for (let z = 0; z < v.sz; z++)
      for (let x = 0; x < v.sx; x++) if (getVoxel(v, x, cy, z) !== EMPTY) depthsAtCenterRow.add(z);
    // an inflated solid occupies many depth layers (a flat card would occupy ~1)
    expect(depthsAtCenterRow.size).toBeGreaterThan(3);
  });

  it("inflation: an interior column is THICKER than a near-edge column (depth follows shape)", () => {
    const f = squareOnBg(17, 13);
    const v = imageToSolid(f, { maxDepth: 16, curve: 1 });
    const colThickness = (x: number, y: number): number => {
      let n = 0;
      for (let z = 0; z < v.sz; z++) if (getVoxel(v, x, y, z) !== EMPTY) n++;
      return n;
    };
    const wy = 17 - 1 - 8; // center row in world coords
    const interior = colThickness(8, wy);
    const nearEdge = colThickness(3, wy); // near the left rim of the subject
    expect(interior).toBeGreaterThan(nearEdge);
    expect(nearEdge).toBeGreaterThanOrEqual(1);
  });

  it("depthOf override drives thickness directly (depth-model / Blender depth-pass hook)", () => {
    const f = squareOnBg(8, 6);
    // constant max depth everywhere on the subject
    const v = imageToSolid(f, { maxDepth: 10, depthOf: () => 1 });
    const wy = 8 - 1 - 4;
    let n = 0;
    for (let z = 0; z < v.sz; z++) if (getVoxel(v, 4, wy, z) !== EMPTY) n++;
    expect(n).toBe(10); // full thickness from the supplied depth map
  });

  it("is NOT a flat slab (distinct from the old relief one-pixel-front behaviour)", () => {
    const f = squareOnBg(12, 8);
    const v = imageToSolid(f, { maxDepth: 10 });
    // a flat front slab would put every solid voxel at z=0; assert solids exist away from z=0
    let awayFromFront = 0;
    forEachSolid(v, (_x, _y, z) => {
      if (z > 0) awayFromFront++;
    });
    expect(awayFromFront).toBeGreaterThan(0);
  });
});
