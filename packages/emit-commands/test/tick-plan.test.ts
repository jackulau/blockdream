import { describe, it, expect } from "vitest";
import { planTickPlayback } from "../src/tick-plan";

describe("planTickPlayback", () => {
  it("keeps every frame at/below 20 fps with the nearest whole-tick dwell", () => {
    const plan = planTickPlayback(10, Array(10).fill(100)); // 10 fps source
    expect(plan.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan.speedTicks).toBe(2);
    expect(plan.fps).toBe(10);
    expect(plan.resampled).toBe(false);
  });

  it("resamples an above-20fps clip evenly down to one frame per tick", () => {
    const plan = planTickPlayback(10, Array(10).fill(25)); // 40 fps, 250 ms total
    expect(plan.resampled).toBe(true);
    expect(plan.speedTicks).toBe(1);
    expect(plan.indices).toHaveLength(5); // 250 ms / 50 ms per tick
    // even, order-preserving thinning within bounds
    for (let i = 1; i < plan.indices.length; i++) {
      expect(plan.indices[i]!).toBeGreaterThan(plan.indices[i - 1]!);
    }
    expect(plan.indices[0]).toBe(0);
    expect(plan.indices.at(-1)!).toBeLessThan(10);
  });

  it("a 2-frame high-fps clip is an identity plan and does NOT claim resampling", () => {
    // repro: target = max(2, round(50/50)) = 2 = n, so the old code returned the
    // identity index list with resampled: true and the CLI printed
    // "resampled 2 -> 2 frames ... same duration" while stretching the duration.
    const plan = planTickPlayback(2, [25, 25]);
    expect(plan.indices).toEqual([0, 1]);
    expect(plan.speedTicks).toBe(1);
    expect(plan.resampled).toBe(false);
  });

  it("any identity plan reports resampled: false (target >= n)", () => {
    // 3 frames x 30 ms = 90 ms -> target = max(2, round(1.8)) = 2 < 3: resampled.
    expect(planTickPlayback(3, [30, 30, 30]).resampled).toBe(true);
    // 2 frames x 40 ms = 80 ms -> target = 2 = n: identity, not resampled.
    const p = planTickPlayback(2, [40, 40]);
    expect(p.indices).toEqual([0, 1]);
    expect(p.resampled).toBe(false);
  });

  it("no timing info keeps the legacy default (2 ticks per frame = 10 fps)", () => {
    const plan = planTickPlayback(6, null);
    expect(plan.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.speedTicks).toBe(2);
    expect(plan.fps).toBe(10);
    expect(plan.resampled).toBe(false);
  });

  it("single-frame and empty clips are identity, never resampled", () => {
    expect(planTickPlayback(1, [10]).resampled).toBe(false);
    expect(planTickPlayback(1, [10]).indices).toEqual([0]);
    expect(planTickPlayback(0, null).indices).toEqual([]);
  });

  it("missing/invalid per-frame durations fall back to fallbackMs", () => {
    const plan = planTickPlayback(4, [undefined, null, -5, 0], 100); // all fall back to 100 ms
    expect(plan.speedTicks).toBe(2);
    expect(plan.resampled).toBe(false);
  });
});
