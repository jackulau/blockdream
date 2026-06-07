import { describe, it, expect } from "vitest";
import {
  easing,
  pingPong,
  transformAnims,
  poseAt,
  sampleKeyframes,
  explodeAssemble,
  wave,
  buildUp,
  generateSequence,
} from "../src/animate";
import { createVolume, setVoxel, countSolid, forEachSolid, type VoxelVolume } from "../src/volume";

function blob(n = 6, id = 4): VoxelVolume {
  const v = createVolume(n, n, n);
  for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) setVoxel(v, x, y, z, id);
  return v;
}
function bbox(v: VoxelVolume): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  forEachSolid(v, (x, y, z) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  });
  return maxX - minX + (maxY - minY) + (maxZ - minZ);
}

describe("easing", () => {
  it("curves hit their endpoints and stay in range", () => {
    for (const fn of Object.values(easing)) {
      expect(fn(0)).toBeCloseTo(0, 5);
      expect(fn(1)).toBeCloseTo(1, 5);
    }
  });
  it("easeInOutSine is symmetric about 0.5", () => {
    expect(easing.easeInOutSine!(0.5)).toBeCloseTo(0.5, 5);
  });
  it("pingPong rises to 1 at the half period and returns to 0", () => {
    expect(pingPong(0, 1)).toBeCloseTo(0, 5);
    expect(pingPong(0.5, 1)).toBeCloseTo(1, 5);
    expect(pingPong(1, 1)).toBeCloseTo(0, 5);
  });
});

describe("transform animations", () => {
  it("spin rotates around Y, monotonically with time, refresh-independent (absolute)", () => {
    const a = transformAnims.spin(1, 10);
    const b = transformAnims.spin(2, 10);
    expect(b.ry).toBeGreaterThan(a.ry);
    expect(a.px).toBe(0);
    expect(a.scale).toBe(1);
  });
  it("none is the identity pose", () => {
    expect(transformAnims.none(5, 10)).toEqual({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, scale: 1 });
  });
  it("pulse varies scale; bob varies vertical position", () => {
    const scales = [0, 0.35, 0.7, 1.05].map((t) => transformAnims.pulse(t, 10).scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.05);
    const ys = [0, 0.4, 0.8, 1.2].map((t) => transformAnims.bob(t, 10).py);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.1);
  });
  it("poseAt falls back to identity for an unknown animation", () => {
    expect(poseAt("nonexistent", 3, 10).ry).toBe(0);
  });
});

describe("sampleKeyframes", () => {
  it("clamps before/after the track and eases between keys", () => {
    const keys = [
      { t: 0, pose: { scale: 0 } },
      { t: 1, pose: { scale: 1 } },
    ];
    expect(sampleKeyframes(keys, -1).scale).toBe(0);
    expect(sampleKeyframes(keys, 2).scale).toBe(1);
    const mid = sampleKeyframes(keys, 0.5, easing.linear);
    expect(mid.scale).toBeCloseTo(0.5, 5);
  });
});

describe("volume-sequence generators", () => {
  it("explodeAssemble: right frame count, ends spread out more than the assembled middle", () => {
    const v = blob();
    const frames = explodeAssemble(v, 12, 6);
    expect(frames.length).toBe(12);
    const endExtent = bbox(frames[0]!);
    const midExtent = bbox(frames[6]!);
    expect(endExtent).toBeGreaterThan(midExtent); // exploded ends are larger than the assembled middle
    // every frame is the same padded size
    expect(frames.every((f) => f.sx === frames[0]!.sx && f.sy === frames[0]!.sy)).toBe(true);
  });

  it("wave: preserves voxel count (pure per-column Y shift) across all frames", () => {
    const v = blob();
    const n = countSolid(v);
    const frames = wave(v, 10, 3);
    expect(frames.length).toBe(10);
    for (const f of frames) expect(countSolid(f)).toBe(n);
  });

  it("buildUp: reveals bottom-to-top, ending at the full model", () => {
    const v = blob();
    const full = countSolid(v);
    const frames = buildUp(v, 8);
    expect(countSolid(frames[0]!)).toBeLessThan(full);
    expect(countSolid(frames[frames.length - 1]!)).toBe(full);
    // monotonic non-decreasing reveal
    for (let i = 1; i < frames.length; i++) expect(countSolid(frames[i]!)).toBeGreaterThanOrEqual(countSolid(frames[i - 1]!));
  });

  it("generateSequence dispatches by name", () => {
    const v = blob();
    expect(generateSequence("explode", v, 6).length).toBe(6);
    expect(generateSequence("wave", v, 6).length).toBe(6);
    expect(generateSequence("buildup", v, 6).length).toBe(6);
  });
});
