import { describe, it, expect } from "vitest";
import { timelineStarts, clipTimeOf, needsResnap, ClipAudio } from "../src/clip-audio";

// The HTMLAudioElement glue can't run under jsdom (no media playback); the testable surface is the
// frame-clock → audio-clock math that decides WHEN the soundtrack sits and when it resnaps.

describe("timelineStarts", () => {
  const expectClose = (got: Float64Array, want: number[]): void => {
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i++) expect(got[i]!).toBeCloseTo(want[i]!, 9);
  };

  it("accumulates per-frame durations into start times (seconds)", () => {
    expectClose(timelineStarts([100, 50, 200, 100]), [0, 0.1, 0.15, 0.35]);
  });

  it("fills unknown durations with the fallback (matches the viewer's uniform fallback)", () => {
    expectClose(timelineStarts([100, undefined, null, 100], 100), [0, 0.1, 0.2, 0.3]);
    expectClose(timelineStarts([undefined], 50), [0]);
  });

  it("a whole-clip timeline at a fixed fps lands each frame at i/fps", () => {
    const fps = 30;
    const durations = Array.from({ length: 90 }, () => 1000 / fps);
    const s = timelineStarts(durations);
    expect(s[30]!).toBeCloseTo(1, 9);
    expect(s[89]!).toBeCloseTo(89 / 30, 9);
  });
});

describe("clipTimeOf", () => {
  const s = timelineStarts([100, 100, 100, 100]);
  it("maps a frame index to its start time", () => {
    expect(clipTimeOf(s, 0)).toBe(0);
    expect(clipTimeOf(s, 2)).toBeCloseTo(0.2, 9);
  });
  it("clamps out-of-range frames (scrub past the end, negative wrap)", () => {
    expect(clipTimeOf(s, 99)).toBeCloseTo(0.3, 9);
    expect(clipTimeOf(s, -3)).toBe(0);
    expect(clipTimeOf(new Float64Array(0), 5)).toBe(0);
  });
});

describe("needsResnap", () => {
  it("small drift is left alone (no per-frame stutter), big drift resnaps", () => {
    expect(needsResnap(10.0, 10.1)).toBe(false);
    expect(needsResnap(10.0, 10.29)).toBe(false);
    expect(needsResnap(10.0, 10.5)).toBe(true);
    expect(needsResnap(10.5, 10.0)).toBe(true); // both directions
  });
  it("loop wrap is always a resnap (end-of-clip → 0)", () => {
    expect(needsResnap(219.0, 0)).toBe(true);
  });
});

describe("ClipAudio (headless)", () => {
  it("is a safe no-op without a browser Audio element", () => {
    const a = new ClipAudio();
    expect(a.hasClip).toBe(false);
    a.setMode("original");
    a.frameShown(3, true); // must not throw with no clip loaded
    a.pause();
    a.dispose();
    expect(a.currentMode).toBe("original");
  });
  it("mode changes are tracked even before a clip loads", () => {
    const a = new ClipAudio();
    a.setMode("noteblocks");
    expect(a.currentMode).toBe("noteblocks");
    a.setMode("mute");
    expect(a.currentMode).toBe("mute");
  });
});
