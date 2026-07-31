import { describe, it, expect } from "vitest";
import { createVolume, getVoxel, setVoxel, countSolid } from "../src/volume";
import { rotateY, spin, spinSequence, padXZToSquare } from "../src/spin";

/** A fully-solid (dense) W×H×D block - the shape framesToAnimated3d produces (filled silhouette). */
function denseSlab(w: number, h: number, d: number): ReturnType<typeof createVolume> {
  const v = createVolume(w, h, d);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setVoxel(v, x, y, z, 5);
  return v;
}

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

describe("spinSequence (baked spin — the optimized --animate spin path)", () => {
  it("emits N frames cube-padded in X/Z; frame 0 is the exact identity", () => {
    const v = denseSlab(8, 4, 2); // non-cubic (shallow depth)
    const base = padXZToSquare(v);
    expect([base.sx, base.sy, base.sz]).toEqual([8, 4, 8]); // squared footprint
    const seq = spinSequence(v, 6);
    expect(seq.length).toBe(6);
    expect([...seq[0]!.data]).toEqual([...base.data]); // angle 0 ⇒ exact identity (vs the padded base)
  });

  it("is byte-identical to the hole-free inverse spin() (optimization preserves output exactly)", () => {
    // the fast path (trig hoisted out of Y + air-column skip) must produce the SAME voxels as the
    // reference inverse-sample - guards the optimization against any quality drift.
    for (const v of [denseSlab(16, 8, 4), denseSlab(10, 5, 12), denseSlab(7, 9, 3)]) {
      const fast = spinSequence(v, 8);
      const ref = spin(padXZToSquare(v), 8, "y");
      expect(fast.length).toBe(ref.length);
      for (let i = 0; i < fast.length; i++) expect([...fast[i]!.data]).toEqual([...ref[i]!.data]);
    }
  });

  it("keeps the build solid through a turn (no wholesale clip; cube-pad holds the swept footprint)", () => {
    const v = denseSlab(16, 8, 4);
    const base = countSolid(v);
    for (const f of spinSequence(v, 8)) expect(countSolid(f)).toBeGreaterThan(base * 0.9);
  });

  it("rejects frames ≤ 0", () => {
    expect(() => spinSequence(createVolume(2, 2, 2), 0)).toThrow(/frames/);
  });

  it("rejects NaN and non-integer frame counts (NaN <= 0 is false, so a bare <=0 guard missed it)", () => {
    expect(() => spinSequence(createVolume(2, 2, 2), NaN)).toThrow(/frames/);
    expect(() => spinSequence(createVolume(2, 2, 2), 2.5)).toThrow(/frames/);
    expect(() => spin(createVolume(2, 2, 2), NaN)).toThrow(/nFrames/);
    expect(() => spin(createVolume(2, 2, 2), 2.5)).toThrow(/nFrames/);
  });
});
