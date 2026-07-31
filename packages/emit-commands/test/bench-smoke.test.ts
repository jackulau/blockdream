import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBench, runAB } from "../bench/emit-bench";

const BASELINE_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "BASELINE.md");

// First column of every data row in a markdown table (skips the header row and the ---- separator).
function tableStageNames(section: string): string[] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]!.trim())
    .filter((cell) => cell !== "stage" && !/^[-:]+$/.test(cell));
}

// The benchmark is a real, runnable harness, not a stub. This guards it against silent rot:
// it must execute every stage and report a finite, positive timing + a non-zero work count
// for each. Tiny sizes keep it fast as a unit test; the real perf run uses the defaults.
describe("emit-commands benchmark harness", () => {
  const tiny = {
    screenW: 16,
    screenH: 12,
    frameCount: 8,
    churn: 0.4,
    boxW: 12,
    boxH: 12,
    boxD: 8,
    voxelSize: 12,
    voxelFrames: 3,
    noteCount: 40,
    iters: 2,
    warmup: 1,
  };
  const stages = runBench(tiny);

  it("runs every emit-path stage", () => {
    const names = stages.map((s) => s.name);
    expect(names).toContain("rgbScreenDeltaLines");
    expect(names).toContain("generateRgbScreenDatapack");
    expect(names).toContain("generateRgbScreenDatapackReference");
    expect(names).toContain("greedyBoxes");
    expect(names).toContain("computeVoxelDeltas");
    expect(names).toContain("noteSequencer(playsound)");
    expect(names).toContain("redstoneSequencer");
    expect(stages.length).toBeGreaterThanOrEqual(7);
  });

  it("reports a finite positive timing and a non-zero work count per stage", () => {
    for (const s of stages) {
      expect(Number.isFinite(s.ms), `${s.name} ms finite`).toBe(true);
      expect(s.ms, `${s.name} ms > 0`).toBeGreaterThan(0);
      expect(s.units, `${s.name} units > 0`).toBeGreaterThan(0);
    }
  });

  // the rigorous A/B (optimized vs its retained byte-identical reference twin, same run)
  // must run and report a finite, positive speedup for every pair.
  const ab = runAB(tiny);
  it("runs the optimized-vs-reference A/B for each retained twin", () => {
    const names = ab.map((s) => s.name);
    expect(names).toContain("rgbscreen-delta-lines");
    expect(names).toContain("greedy-boxes");
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

  // goal 050: the dense-grid greedy mesh must be measurably FASTER than the retained
  // string-key fallback (byte-identical output, locked by greedy-boxes.test.ts). retry:
  // a timing inversion needs a sustained hostile phase across every attempt, while a
  // genuine regression loses all attempts in any environment (rgbscreen-perf convention).
  it("the dense greedyBoxes beats the string-key sparse reference on a larger block", { retry: 2, timeout: 30000 }, () => {
    const big = runAB({ boxW: 48, boxH: 48, boxD: 16, iters: 3, warmup: 1, screenW: 16, screenH: 12, frameCount: 8 });
    const gb = big.find((s) => s.name === "greedy-boxes");
    expect(gb).toBeDefined();
    expect(gb!.speedup).toBeGreaterThan(1.5);
  });
});
