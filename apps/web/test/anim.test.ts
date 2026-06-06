import { describe, it, expect } from "vitest";
import { buildSchedule, uniformSchedule, frameAtElapsed, startOfFrame, MIN_FRAME_MS } from "../src/anim";

describe("frame-playback timing (honors per-frame GIF durations)", () => {
  it("buildSchedule accumulates per-frame durations", () => {
    const s = buildSchedule([100, 200, 50]);
    expect(s.cumulative).toEqual([100, 300, 350]);
    expect(s.total).toBe(350);
    expect(s.count).toBe(3);
  });

  it("substitutes a fallback for missing / non-positive durations", () => {
    const s = buildSchedule([undefined, 0, -5, null], 40);
    expect(s.cumulative).toEqual([40, 80, 120, 160]);
  });

  it("clamps absurd 0-ish frames to MIN_FRAME_MS (no CPU pinning)", () => {
    const s = buildSchedule([1, 2]); // both < MIN
    expect(s.cumulative).toEqual([MIN_FRAME_MS, MIN_FRAME_MS * 2]);
  });

  it("maps elapsed time to the right frame across variable delays", () => {
    const s = buildSchedule([100, 200, 50]); // ends 100,300,350
    expect(frameAtElapsed(s, 0)).toBe(0);
    expect(frameAtElapsed(s, 99)).toBe(0);
    expect(frameAtElapsed(s, 100)).toBe(1); // frame 0 ends at 100 → next
    expect(frameAtElapsed(s, 299)).toBe(1);
    expect(frameAtElapsed(s, 300)).toBe(2);
    expect(frameAtElapsed(s, 349)).toBe(2);
  });

  it("loops over the total duration", () => {
    const s = buildSchedule([100, 200, 50]); // total 350
    expect(frameAtElapsed(s, 350)).toBe(0); // wrapped
    expect(frameAtElapsed(s, 450)).toBe(1);
    expect(frameAtElapsed(s, -50)).toBe(2); // negative wraps to last segment
  });

  it("non-loop mode clamps to the last frame", () => {
    const s = buildSchedule([100, 200, 50]);
    expect(frameAtElapsed(s, 99999, false)).toBe(2);
    expect(frameAtElapsed(s, -1, false)).toBe(0);
  });

  it("a slow GIF (250ms/frame) is NOT played at the old hardcoded 8fps (125ms)", () => {
    // regression: previously playback ignored durations and ran every 1000/8 = 125ms.
    const s = buildSchedule([250, 250]); // real GIF cadence
    expect(frameAtElapsed(s, 125)).toBe(0); // at 125ms a correct player is STILL on frame 0
    expect(frameAtElapsed(s, 250)).toBe(1); // advances only at the real 250ms boundary
  });

  it("single frame or empty schedule is always frame 0", () => {
    expect(frameAtElapsed(buildSchedule([100]), 9999)).toBe(0);
    expect(frameAtElapsed(buildSchedule([]), 10)).toBe(0);
  });

  it("uniformSchedule reproduces a fixed fps", () => {
    const s = uniformSchedule(4, 10); // 100ms/frame
    expect(s.cumulative).toEqual([100, 200, 300, 400]);
    expect(frameAtElapsed(s, 250)).toBe(2);
  });

  it("startOfFrame returns each frame's begin offset (for resume-from-current)", () => {
    const s = buildSchedule([100, 200, 50]);
    expect(startOfFrame(s, 0)).toBe(0);
    expect(startOfFrame(s, 1)).toBe(100);
    expect(startOfFrame(s, 2)).toBe(300);
  });
});
