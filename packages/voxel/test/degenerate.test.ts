import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid } from "../src/depth";
import { imageToVolume } from "../src/voxelize";
import { createVolume, countSolid, MAX_DIM, MAX_VOXELS } from "../src/volume";

// goal 036 D2/D6: degenerate inputs must never silently emit an empty build, and absurd sizes must be
// clamped / rejected instead of allocating unbounded memory.
function frame(width: number, height: number, fill: number | number[]): QuantizedFrame {
  const mapColorId = new Uint8Array(width * height);
  if (Array.isArray(fill)) mapColorId.set(fill);
  else mapColorId.fill(fill);
  return { width, height, mapColorId, paletteIndex: new Int32Array(width * height) };
}

describe("degenerate-input guards (D2)", () => {
  it("an all-one-colour image builds a slab instead of an empty result", () => {
    // auto background-removal would erase every pixel (border colour == all pixels); the guard
    // falls back to treating the whole frame as the subject, so it builds something.
    const v = imageToSolid(frame(8, 8, 6), { maxDepth: 4 });
    expect(countSolid(v)).toBeGreaterThan(0);
  });

  it("NaN/Inf depth is sanitized to 0 - never leaks NaN voxels (empty per-frame is OK; the CLI guards aggregate)", () => {
    // a full-NaN field sanitizes to 0 depth -> an empty volume (legitimate for one video frame), NOT garbage
    const empty = imageToSolid(frame(8, 8, 6), { depthOf: () => NaN });
    expect(empty.data.every((c) => c === 255)).toBe(true); // all air, no NaN
    // a partial-NaN field still builds the finite-depth pixels
    const v = imageToSolid(frame(4, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), {
      background: "none",
      depthOf: (x) => (x === 0 ? NaN : 1),
    });
    expect(countSolid(v)).toBeGreaterThan(0);
    expect(v.data.every((c) => c === 255 || Number.isInteger(c))).toBe(true); // no NaN leaked in
  });

  it("an empty frame throws rather than allocating a 0-size volume", () => {
    expect(() => imageToSolid(frame(0, 0, 0), {})).toThrow();
  });
});

describe("size clamps + memory budget (D6)", () => {
  it("absurd maxDepth is clamped to MAX_DIM, not allocated", () => {
    const v = imageToSolid(frame(4, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), {
      maxDepth: 100000,
      background: "none",
    });
    expect(v.sz).toBe(MAX_DIM);
  });

  it("voxelize clamps depth/maxHeight to MAX_DIM", () => {
    expect(imageToVolume(frame(2, 2, 5), { mode: "flat", depth: 99999 }).sz).toBe(MAX_DIM);
    expect(imageToVolume(frame(2, 2, 5), { mode: "heightmap", maxHeight: 99999 }).sy).toBe(MAX_DIM);
  });

  it("createVolume rejects a volume over the voxel budget", () => {
    expect(() => createVolume(1000, 1000, 1000)).toThrow(/exceeds/i); // 1e9 > MAX_VOXELS
    expect(MAX_VOXELS).toBeLessThan(1_000_000_000);
  });

  it("a normal frame still builds without throwing", () => {
    // a 2-colour frame: a centred subject on a border background
    const ids = new Array(64).fill(2);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) ids[y * 8 + x] = 30;
    expect(countSolid(imageToSolid(frame(8, 8, ids), { maxDepth: 6 }))).toBeGreaterThan(0);
  });
});
