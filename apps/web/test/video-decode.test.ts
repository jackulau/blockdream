import { describe, it, expect } from "vitest";
import { isVideoFile, planFrameTimes } from "../src/video";

// The browser <video> seek-loop in decodeVideo can't run under jsdom (no real codec), so - exactly
// like gif.ts keeps its timing math in anim.ts - the testable surface is the pure sampling plan +
// the format sniffing. These are what actually decide "how many block-animation frames, when".

describe("isVideoFile", () => {
  it("matches video MIME types", () => {
    expect(isVideoFile({ type: "video/mp4", name: "x" })).toBe(true);
    expect(isVideoFile({ type: "video/webm" })).toBe(true);
  });
  it("matches video extensions when MIME is absent", () => {
    for (const n of ["clip.mp4", "a.WEBM", "b.mov", "c.m4v", "d.mkv"]) {
      expect(isVideoFile({ name: n })).toBe(true);
    }
  });
  it("rejects non-video files", () => {
    for (const f of [{ name: "a.gif", type: "image/gif" }, { name: "b.obj" }, { name: "c.png" }, { type: "image/png" }, {}]) {
      expect(isVideoFile(f)).toBe(false);
    }
  });
});

describe("planFrameTimes", () => {
  it("always returns at least one time starting at 0", () => {
    expect(planFrameTimes(0)).toEqual([0]);
    expect(planFrameTimes(-5)).toEqual([0]);
    expect(planFrameTimes(NaN)).toEqual([0]);
    expect(planFrameTimes(Infinity)).toEqual([0]);
    expect(planFrameTimes(2)[0]).toBe(0);
  });

  it("samples at the requested fps", () => {
    // 2s at 10fps → ~21 candidate frames, well under the default cap
    const t = planFrameTimes(2, { fps: 10 });
    expect(t.length).toBe(21);
  });

  it("never exceeds maxFrames and samples evenly across the whole clip", () => {
    const t = planFrameTimes(100, { fps: 30, maxFrames: 12 });
    expect(t.length).toBe(12);
    // strictly ascending
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    // spans most of the clip but never lands exactly on the end (a final seek that never fires)
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]!).toBeLessThan(100);
    expect(t[t.length - 1]!).toBeGreaterThan(90);
  });

  it("keeps the last sample strictly inside the clip", () => {
    for (const dur of [0.5, 1, 5, 30]) {
      const t = planFrameTimes(dur, { fps: 24 });
      expect(t[t.length - 1]!).toBeLessThan(dur);
    }
  });

  it("frame count SCALES with the chosen fps for a whole video (no fixed cap in the way)", () => {
    // the Bad Apple case: 219 s. The import passes maxFrames = fps * 660 (11-minute ceiling),
    // so the fps selector - not a hardcoded cap - decides the frame count.
    const dur = 219;
    for (const fps of [10, 20, 30, 60]) {
      const t = planFrameTimes(dur, { fps, maxFrames: Math.ceil(fps * 660) });
      expect(t.length).toBe(Math.floor(dur * fps) + 1); // ~1:1 with the source at that fps
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]!).toBeLessThan(dur);
    }
    // 60 fps yields exactly 6x the frames of 10 fps (minus rounding on the +1)
    const n10 = planFrameTimes(dur, { fps: 10, maxFrames: 999999 }).length;
    const n60 = planFrameTimes(dur, { fps: 60, maxFrames: 999999 }).length;
    expect(n60).toBeGreaterThan(n10 * 5.9);
  });

  it("sampled intervals at a chosen fps are uniform (playback timing matches the request)", () => {
    const t = planFrameTimes(10, { fps: 30, maxFrames: 100000 });
    const step = t[1]! - t[0]!;
    expect(step).toBeCloseTo(1 / 30, 3);
    for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeCloseTo(step, 9);
  });
});
