import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBench, runAB } from "../bench/voxel-bench";

const BASELINE_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "BASELINE.md");

// First column of every data row in a markdown table (skips the header row and the ---- separator).
function tableStageNames(section: string): string[] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]!.trim())
    .filter((cell) => cell !== "stage" && !/^[-:]+$/.test(cell));
}

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

  // The committed BASELINE.md snapshot must cover EVERY stage the harness reports, in order.
  // Both sides are derived programmatically (stage names from the tables vs the harness's own
  // reported lists), so adding/renaming/removing a stage without refreshing the doc fails here.
  it("BASELINE.md names every stage the harness reports", () => {
    const md = readFileSync(BASELINE_MD, "utf8");
    const absStart = md.indexOf("## Absolute timings");
    const abStart = md.indexOf("## A/B");
    expect(absStart, "BASELINE.md has an Absolute timings section").toBeGreaterThanOrEqual(0);
    expect(abStart, "BASELINE.md has an A/B section").toBeGreaterThan(absStart);
    expect(tableStageNames(md.slice(absStart, abStart)), "absolute-timings table stages").toEqual(
      stages.map((s) => s.name),
    );
    expect(tableStageNames(md.slice(abStart)), "A/B table stages").toEqual(ab.map((s) => s.name));
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
