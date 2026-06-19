import { describe, it, expect } from "vitest";
import { runBench, runAB } from "../bench/voxel-bench";

// The benchmark is a real, runnable harness — not a stub. This guards it against silent rot:
// it must execute every stage and report a finite, positive timing + a non-zero work count for
// each. Tiny sizes keep it fast as a unit test; the real perf run uses the default (large) sizes.
describe("voxel benchmark harness", () => {
  const stages = runBench({ imgSize: 48, flatDepth: 8, shellSize: 24, iters: 2, warmup: 1 });

  it("runs every fill-path stage", () => {
    const names = stages.map((s) => s.name);
    expect(names).toContain("imageToSolid");
    expect(names).toContain("imageToVolume(flat)");
    expect(names).toContain("volumeToFrame");
    expect(names).toContain("solidify(shell)");
    expect(names).toContain("forEachSolid");
    expect(stages.length).toBeGreaterThanOrEqual(6);
  });

  it("reports a finite positive timing and a non-zero work count per stage", () => {
    for (const s of stages) {
      expect(Number.isFinite(s.ms), `${s.name} ms finite`).toBe(true);
      expect(s.ms, `${s.name} ms > 0`).toBeGreaterThan(0);
      expect(s.units, `${s.name} units > 0`).toBeGreaterThan(0);
    }
  });

  // the rigorous A/B (optimized vs bounds-checked reference, same run) must run and report a
  // finite, positive speedup for every pair — this is what replaces the flawed stale-baseline delta.
  const ab = runAB({ imgSize: 48, flatDepth: 8, iters: 2, warmup: 1 });
  it("runs the optimized-vs-reference A/B for each changed loop", () => {
    const names = ab.map((s) => s.name);
    expect(names).toContain("column-fill");
    expect(names).toContain("full-scan-fill");
    expect(names).toContain("project-scan");
    expect(names).toContain("spinSequence");
    for (const s of ab) {
      expect(Number.isFinite(s.speedup), `${s.name} speedup finite`).toBe(true);
      expect(s.optMs, `${s.name} optMs > 0`).toBeGreaterThan(0);
      expect(s.refMs, `${s.name} refMs > 0`).toBeGreaterThan(0);
      expect(s.speedup, `${s.name} speedup > 0`).toBeGreaterThan(0);
    }
  });

  // goal 045: the optimized spinSequence must be measurably FASTER than the reference inverse spin
  // (same byte-identical output). At a non-trivial size the air-column skip makes the win clear.
  it("the optimized spinSequence beats the reference inverse spin on a larger build", () => {
    const big = runAB({ imgSize: 96, flatDepth: 8, iters: 3, warmup: 1 });
    const sp = big.find((s) => s.name === "spinSequence");
    expect(sp).toBeDefined();
    expect(sp!.speedup).toBeGreaterThan(1.5);
  }, 20000);
});
