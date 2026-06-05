import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "../src/ffmpeg";
import { extractFrames } from "../src/extract";
import { resizeAreaLinear } from "../src/resize";
import { createRgbImage, setPixel } from "@mineworld/color-core";

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-video-"));
  gif = join(dir, "test.gif");
  // synthetic 32×32, 10 fps, 1s clip → 10 frames
  const r = runFfmpeg([
    "-v", "error", "-f", "lavfi",
    "-i", "testsrc2=size=32x32:rate=10:duration=1",
    "-y", gif,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

d("extractFrames (ffmpeg)", () => {
  it("decodes a clip into RGB frames at the requested grid size", () => {
    const frames = extractFrames(gif, { width: 16, height: 16, fps: 10 });
    expect(frames.length).toBeGreaterThanOrEqual(8);
    expect(frames.length).toBeLessThanOrEqual(12);
    for (const f of frames) {
      expect(f.width).toBe(16);
      expect(f.height).toBe(16);
      expect(f.data.length).toBe(16 * 16 * 3);
    }
  });

  it("respects maxFrames", () => {
    const frames = extractFrames(gif, { width: 8, height: 8, fps: 10, maxFrames: 3 });
    expect(frames.length).toBe(3);
  });

  it("produces non-uniform frames (testsrc2 has structure)", () => {
    const [f] = extractFrames(gif, { width: 16, height: 16, fps: 10, maxFrames: 1 });
    const distinct = new Set<number>();
    for (let i = 0; i < f!.data.length; i += 3) distinct.add((f!.data[i]! << 16) | (f!.data[i + 1]! << 8) | f!.data[i + 2]!);
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("resizeAreaLinear", () => {
  it("downscales and averages two half-colors in linear light", () => {
    // 2×1 image: left black, right white → 1×1 should be linear-mid (~188 in sRGB)
    const img = createRgbImage(2, 1);
    setPixel(img, 0, 0, 0, 0, 0);
    setPixel(img, 1, 0, 255, 255, 255);
    const out = resizeAreaLinear(img, 1, 1);
    expect(out.width).toBe(1);
    // linear average of 0 and 1 = 0.5 → sRGB ≈ 188 (NOT 128, which would be gamma-space)
    expect(out.data[0]).toBeGreaterThan(180);
    expect(out.data[0]).toBeLessThan(195);
  });

  it("preserves a solid color exactly", () => {
    const img = createRgbImage(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(img, x, y, 10, 120, 200);
    const out = resizeAreaLinear(img, 2, 2);
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([10, 120, 200]);
  });
});

if (ff) {
  // cleanup once after suite (best-effort)
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
