import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { framesToAnimated3d } from "../src/video3d";
import { getVoxel, forEachSolid, EMPTY, type VoxelVolume } from "@blockdream/voxel";

// a `sub`×`sub` square subject (id 5) at (px,py) on a background (id 0)
function squareFrame(size: number, sub: number, px: number, py: number): QuantizedFrame {
  const ids = new Array(size * size).fill(0);
  for (let y = py; y < py + sub && y < size; y++) for (let x = px; x < px + sub && x < size; x++) ids[y * size + x] = 5;
  return { width: size, height: size, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) };
}
function centroidX(v: VoxelVolume): number {
  let s = 0, n = 0;
  forEachSolid(v, (x) => { s += x; n++; });
  return n ? s / n : 0;
}
function maxThickness(v: VoxelVolume): number {
  let max = 0;
  for (let y = 0; y < v.sy; y++)
    for (let x = 0; x < v.sx; x++) {
      let c = 0;
      for (let z = 0; z < v.sz; z++) if (getVoxel(v, x, y, z) !== EMPTY) c++;
      if (c > max) max = c;
    }
  return max;
}

describe("framesToAnimated3d", () => {
  it("turns each frame into a real 3D solid (not a flat slab) and isolates the subject", () => {
    const frames = [squareFrame(16, 6, 2, 5), squareFrame(16, 6, 5, 5), squareFrame(16, 6, 8, 5)];
    const vols = framesToAnimated3d(frames, { maxDepth: 10, smooth: 0 });
    expect(vols.length).toBe(3);
    for (const v of vols) {
      expect([v.sx, v.sy, v.sz]).toEqual([16, 16, 10]);
      // background corner is air across all depth
      for (let z = 0; z < v.sz; z++) expect(getVoxel(v, 0, 0, z)).toBe(EMPTY);
      // genuinely 3D: occupies multiple depth layers (a flat slab would occupy ~1-2)
      const zLayers = new Set<number>();
      forEachSolid(v, (_x, _y, z) => zLayers.add(z));
      expect(zLayers.size).toBeGreaterThan(3);
    }
  });

  it("keeps a stable grid size across all frames (temporal stability - no per-frame rescale)", () => {
    const frames = [squareFrame(20, 4, 2, 2), squareFrame(20, 10, 5, 5), squareFrame(20, 6, 12, 12)];
    const vols = framesToAnimated3d(frames, { maxDepth: 12 });
    expect(vols.every((v) => v.sx === 20 && v.sy === 20 && v.sz === 12)).toBe(true);
  });

  it("follows subject motion (centroid tracks a moving square)", () => {
    const frames = [squareFrame(24, 6, 2, 9), squareFrame(24, 6, 9, 9), squareFrame(24, 6, 16, 9)];
    const vols = framesToAnimated3d(frames, { maxDepth: 8, smooth: 0 });
    expect(centroidX(vols[2]!)).toBeGreaterThan(centroidX(vols[0]!) + 4);
  });

  it("global depth normalization preserves relative scale (bigger subject → deeper build)", () => {
    const frames = [squareFrame(24, 4, 10, 10), squareFrame(24, 16, 4, 4)]; // small then big
    const vols = framesToAnimated3d(frames, { maxDepth: 16, smooth: 0 });
    // the larger silhouette reaches deeper than the small one under the SHARED normalization
    expect(maxThickness(vols[1]!)).toBeGreaterThan(maxThickness(vols[0]!));
  });

  it("depthForFrame override drives the thickness directly (depth-model / Blender depth-pass hook)", () => {
    const frames = [squareFrame(12, 8, 2, 2)];
    const vols = framesToAnimated3d(frames, { maxDepth: 10, depthForFrame: () => 1 });
    expect(maxThickness(vols[0]!)).toBe(10); // full thickness everywhere on the subject
  });

  it("empty input yields no frames", () => {
    expect(framesToAnimated3d([]).length).toBe(0);
  });
});
