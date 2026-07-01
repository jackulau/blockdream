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
});
