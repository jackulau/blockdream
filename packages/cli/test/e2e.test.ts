import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@mineworld/video";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette, meanMatchError, quantizeFrame } from "@mineworld/color-core";
import { extractFrames } from "@mineworld/video";
import { readMapColors, toMapColors } from "@mineworld/emit-java";
import { render } from "../src/render";
import { previewPng } from "../src/preview";

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let clip: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-e2e-"));
  clip = join(dir, "clip.mp4");
  // structured, recognizable content (SMPTE-like bars + motion)
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=8:duration=1", "-y", clip]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

d("end-to-end real content", () => {
  const pal = preparePalette(getJavaMapPalette());

  it("renders a real clip to a datapack (frame functions == frames)", () => {
    const out = join(dir, "dp");
    const res = render({ input: clip, out, target: "datapack", width: 64, height: 64, maxFrames: 4 });
    expect(res.frameCount).toBe(4);
    expect(JSON.parse(readFileSync(join(out, "pack.mcmeta"), "utf8")).pack.pack_format).toBe(48);
  });

  it("map.dat round-trips: written colors == freshly quantized", () => {
    const out = join(dir, "map");
    render({ input: clip, out, target: "map", width: 128, height: 128, maxFrames: 1, edition: "java" });
    const dat = readFileSync(join(out, "map_0.dat"));
    const got = readMapColors(dat);
    const [src] = extractFrames(clip, { width: 128, height: 128, maxFrames: 1 });
    const fresh = toMapColors(quantizeFrame(src!, pal, { method: "floyd-steinberg" }));
    expect([...got]).toEqual([...fresh]);
  });

  it("real content renders with good color fidelity (low mean ΔE)", () => {
    const [src] = extractFrames(clip, { width: 96, height: 96, maxFrames: 1 });
    expect(meanMatchError(src!, pal)).toBeLessThan(0.08);
  });

  it("produces a valid side-by-side preview PNG", () => {
    const png = previewPng(clip, { grid: 64, method: "floyd-steinberg", scale: 4 });
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.length).toBeGreaterThan(1000);
  });
});
