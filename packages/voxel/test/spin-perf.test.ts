// Locks the goal-089 D19 spinSequence inner-loop optimization (hoisted running indices replacing
// per-voxel getVoxel/setVoxel in the Y column copy) against its verbatim pre-optimization reference
// twin: byte-identity on random volumes + all 4 quarter-turns, then same-run interleaved A/B timing.

import { describe, it, expect } from "vitest";
import { spinSequence, spinSequenceReference, rotateYQuarterTurns, padXZToSquare } from "../src/spin";
import { createVolume, setVoxel, type VoxelVolume } from "../src/volume";

// deterministic PRNG (same generator the bench uses) so every run tests the same volumes
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random-content volume: `density` of cells get a random non-air colour id. */
function randomVolume(sx: number, sy: number, sz: number, seed: number, density = 0.35): VoxelVolume {
  const rnd = mulberry32(seed);
  const v = createVolume(sx, sy, sz);
  const cells = Math.floor(v.data.length * density);
  for (let k = 0; k < cells; k++) {
    const i = Math.floor(rnd() * v.data.length);
    v.data[i] = 2 + Math.floor(rnd() * 200);
  }
  return v;
}

function expectVolumesByteIdentical(opt: VoxelVolume, ref: VoxelVolume): void {
  expect([opt.sx, opt.sy, opt.sz]).toEqual([ref.sx, ref.sy, ref.sz]);
  expect(Buffer.compare(Buffer.from(opt.data), Buffer.from(ref.data))).toBe(0);
}

function expectSequencesByteIdentical(v: VoxelVolume, frames: number): VoxelVolume[] {
  const opt = spinSequence(v, frames);
  const ref = spinSequenceReference(v, frames);
  expect(opt.length).toBe(ref.length);
  for (let i = 0; i < opt.length; i++) expectVolumesByteIdentical(opt[i]!, ref[i]!);
  return opt;
}

describe("spinSequence is byte-identical to the verbatim reference", () => {
  it("random volumes: cubic, non-cubic (pad-triggering), thin slabs, single-plane", () => {
    expectSequencesByteIdentical(randomVolume(16, 16, 16, 1), 8); // already-square footprint
    expectSequencesByteIdentical(randomVolume(33, 17, 9, 42), 7); // odd dims + X/Z pad
    expectSequencesByteIdentical(randomVolume(8, 24, 31, 0xbeef), 5); // depth > width pad
    expectSequencesByteIdentical(randomVolume(20, 1, 20, 0x9e3779b9), 6); // single Y plane
    expectSequencesByteIdentical(randomVolume(24, 12, 2, 7, 0.9), 9); // dense thin slab
  });

  it("frame-count edges: 1 frame (identity only) and the default-heavy 24", () => {
    expectSequencesByteIdentical(randomVolume(12, 9, 5, 3), 1);
    expectSequencesByteIdentical(randomVolume(14, 6, 14, 4), 24);
  });

  it("all 4 quarter-turns (frames=4 hits 0/90/180/270 exactly, the rounding edge)", () => {
    const v = randomVolume(21, 10, 13, 0x5eed);
    const opt = expectSequencesByteIdentical(v, 4);
    // sanity beyond twin-identity: at exact quarter angles the inverse sample is lossless on the
    // padded square footprint, so each frame matches the exact lossless quarter-turn rotation
    const base = padXZToSquare(v);
    for (let t = 0; t < 4; t++) {
      // spinSequence's angle f is a CCW spin of the build; rotateYQuarterTurns(base, t) matches
      // frame (4 - t) % 4 of the sequence on a square footprint (same convention as the viewer)
      const exact = rotateYQuarterTurns(base, t);
      expectVolumesByteIdentical(opt[(4 - t) % 4]!, exact);
    }
  });

  it("all-air and single-voxel volumes", () => {
    expectSequencesByteIdentical(createVolume(9, 4, 9), 6); // all air -> colSolid mask all zero
    const one = createVolume(11, 3, 5);
    setVoxel(one, 10, 2, 4, 99); // corner voxel exercises the pad offset + range checks
    expectSequencesByteIdentical(one, 8);
  });
});

// Same-run interleaved A/B (same protocol as obj-perf.test.ts): ref/opt ORDER alternates each round
// so whoever runs second inherits the first's GC debt equally; compare MEDIANS so a stray
// GC/scheduler spike cannot poison the result; retry so a false failure needs a hostile phase across
// every attempt while a real regression fails them all.
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
}

function timedAB(runRef: () => unknown, runOpt: () => unknown, rounds: number): { refMs: number; optMs: number } {
  const timed = (fn: () => unknown): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  const refTimes: number[] = [];
  const optTimes: number[] = [];
  for (let iter = 0; iter < rounds; iter++) {
    if (iter % 2 === 0) {
      refTimes.push(timed(runRef));
      optTimes.push(timed(runOpt));
    } else {
      optTimes.push(timed(runOpt));
      refTimes.push(timed(runRef));
    }
  }
  return { refMs: medianOf(refTimes), optMs: medianOf(optTimes) };
}

describe("spinSequence perf (same-run interleaved A/B vs the verbatim reference)", () => {
  it("is byte-identical AND >=1.5x faster on a dense 96x48x48 volume", { retry: 2, timeout: 120000 }, () => {
    const v = randomVolume(96, 48, 48, 0xabc, 0.6); // dense -> almost every column survives the mask
    const frames = 6;
    const runRef = () => spinSequenceReference(v, frames);
    const runOpt = () => spinSequence(v, frames);
    // byte identity on the timed input + JIT warmup
    const opt = runOpt();
    const ref = runRef();
    for (let i = 0; i < frames; i++) expectVolumesByteIdentical(opt[i]!, ref[i]!);
    const { refMs, optMs } = timedAB(runRef, runOpt, 12);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // measured ~4x locally (per-voxel inBounds+voxelIndex removed from the Y copy); conservative
    // floor so a busy CI box cannot flake the gate
    expect(refMs / optMs).toBeGreaterThanOrEqual(1.5);
  });
});
