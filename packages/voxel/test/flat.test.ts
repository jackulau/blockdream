import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToFlat, framesToFlat3d } from "../src/flat";
import { countSolid, getVoxel, EMPTY } from "../src/volume";

// goal 078 — the flat voxelizer is the parity path for 2D motion-graphic GIFs/videos. It must be the
// deliberate opposite of imageToSolid: faithful front face, NO background isolation, NO inflation.
function frame(w: number, h: number, fill: (x: number, y: number) => number): QuantizedFrame {
  const mapColorId = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mapColorId[y * w + x] = fill(x, y);
  return { width: w, height: h, mapColorId, paletteIndex: new Int32Array(w * h) };
}

describe("imageToFlat", () => {
  it("emits a width × height × depth slab", () => {
    const v = imageToFlat(frame(8, 5, () => 7), { depth: 3 });
    expect([v.sx, v.sy, v.sz]).toEqual([8, 5, 3]);
  });

  it("defaults to a single-block-deep wall", () => {
    const v = imageToFlat(frame(4, 4, () => 7));
    expect(v.sz).toBe(1);
  });

  it("keeps EVERY pixel (no background isolation) — the literal full rectangle", () => {
    // a 'subject on a border background' that imageToSolid WOULD strip to just the subject
    const subject = (x: number, y: number) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? 30 : 2);
    const v = imageToFlat(frame(8, 8, subject), { depth: 2 });
    // every one of the 8×8 columns survives × depth 2 → 128 solid voxels; the border bg is NOT removed
    expect(countSolid(v)).toBe(8 * 8 * 2);
  });

  it("front face IS the image, block-for-block, and upright (row 0 → top)", () => {
    // distinct id per pixel so we can check exact placement + orientation
    const w = 4;
    const h = 3;
    const v = imageToFlat(frame(w, h, (x, y) => 10 + y * w + x), { depth: 1 });
    for (let iy = 0; iy < h; iy++)
      for (let ix = 0; ix < w; ix++) {
        const wy = h - 1 - iy; // upright: image row 0 lands at the top world-Y
        expect(getVoxel(v, ix, wy, 0)).toBe(10 + iy * w + ix);
      }
    // top-left image pixel (id 10) sits at the TOP of the build, not the bottom
    expect(getVoxel(v, 0, h - 1, 0)).toBe(10);
  });

  it("no silhouette inflation: a single pixel stays a single column (a dome would bulge it)", () => {
    const one = (x: number, y: number) => (x === 4 && y === 4 ? 30 : 2);
    const v = imageToFlat(frame(9, 9, one), { depth: 4 });
    // exactly the 81 columns × 4 deep — flat, no bulge concentrated at the centre
    expect(countSolid(v)).toBe(9 * 9 * 4);
  });

  it("isAir maps transparent pixels to air so the subject can float", () => {
    // drop the whole top half via the air predicate
    const v = imageToFlat(frame(6, 6, () => 30), { depth: 1, isAir: (_x, y) => y < 3 });
    expect(countSolid(v)).toBe(6 * 3); // only the bottom 3 image rows remain
    // an air column really is EMPTY (image row 0 → world y = top)
    expect(getVoxel(v, 0, 5, 0)).toBe(EMPTY);
    // a kept column is solid (image row 5 → world y = 0)
    expect(getVoxel(v, 0, 0, 0)).toBe(30);
  });

  it("rejects an empty frame", () => {
    expect(() => imageToFlat(frame(0, 0, () => 0))).toThrow();
  });
});

describe("framesToFlat3d", () => {
  it("returns one flat volume per frame, all the same size", () => {
    const vols = framesToFlat3d([frame(8, 8, () => 5), frame(8, 8, () => 5)], { depth: 2 });
    expect(vols.length).toBe(2);
    expect(vols.every((v) => v.sx === 8 && v.sy === 8 && v.sz === 2)).toBe(true);
  });

  it("applies a per-frame air mask (transparency that changes over time)", () => {
    // frame 0 fully opaque, frame 1 fully transparent
    const vols = framesToFlat3d([frame(4, 4, () => 9), frame(4, 4, () => 9)], {
      depth: 1,
      isAirForFrame: (f) => f === 1,
    });
    expect(countSolid(vols[0]!)).toBe(16);
    expect(countSolid(vols[1]!)).toBe(0);
  });

  it("empty input returns no volumes", () => {
    expect(framesToFlat3d([], { depth: 2 })).toEqual([]);
  });
});
