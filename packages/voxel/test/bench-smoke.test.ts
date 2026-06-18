import { describe, it, expect } from "vitest";
import { runBench } from "../bench/voxel-bench";

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
});
