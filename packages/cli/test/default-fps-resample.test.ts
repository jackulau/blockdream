import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { hasFfprobe, probeSourceFps } from "../src/probe";
import { render } from "../src/render";

// D2 (goal 087): the >20 fps honesty resample only fired when --fps was EXPLICIT. On the default
// path (no --fps) extractFrames omits the fps filter, so a 60 fps source decoded all 60 frames
// and the pack fell back to speed 2 (10 fps playback) = a 6x-slow pack, silently. render now
// probes the source's own rate (ffprobe) and runs the SAME shared planTickPlayback resample.

const ok = hasFfmpeg() && hasFfprobe();
const d = ok ? describe : describe.skip;

let dir: string;
let clip60: string; // 60 fps source - above the 20 fps in-game ceiling
let clip8: string; // 8 fps source - at/below the ceiling, must stay untouched

beforeAll(() => {
  if (!ok) return;
  dir = mkdtempSync(join(tmpdir(), "mw-deffps-"));
  clip60 = join(dir, "clip60.mp4");
  clip8 = join(dir, "clip8.mp4");
  let r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=60:duration=1", "-y", clip60]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
  r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=1", "-y", clip8]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

function speedOf(out: string): string {
  const setup = readFileSync(join(out, "data", "blockdream_3d", "function", "setup.mcfunction"), "utf8");
  const m = setup.match(/scoreboard players set #speed ma (\d+)/);
  return m ? m[1]! : "(missing)";
}

d("default --fps path resamples >20 fps sources (no silent slow-motion packs)", () => {
  it("probeSourceFps reads the source's own frame rate", () => {
    expect(probeSourceFps(clip60)).toBeCloseTo(60, 3);
    expect(probeSourceFps(clip8)).toBeCloseTo(8, 3);
    expect(probeSourceFps(join(dir, "nope.mp4"))).toBeUndefined(); // fail open, never throw
  });

  it("no --fps on a 60 fps source: resampled to ~20 frames at 1 tick/frame, with the honesty note", () => {
    const out = join(dir, "def60");
    const res = render({ input: clip60, out, target: "voxel3d", width: 16, height: 16, wall: true });
    // the note names the SOURCE rate (there was no --fps to blame)
    expect(res.notes.join("\n")).toMatch(/the source's 60 fps is above Minecraft's 20 fps.*resampled \d+ → \d+/s);
    expect(speedOf(out)).toBe("1");
    // 1 s at 60 fps → ~20 frames at the 20 fps ceiling (duration preserved, frames skipped)
    expect(res.frameCount).toBeGreaterThanOrEqual(18);
    expect(res.frameCount).toBeLessThanOrEqual(22);
  });

  it("no --fps on an 8 fps source: untouched (no resample, historical speed-2 default)", () => {
    const out = join(dir, "def8");
    const res = render({ input: clip8, out, target: "voxel3d", width: 16, height: 16, wall: true });
    expect(res.notes.join("\n")).not.toMatch(/resampled/);
    expect(speedOf(out)).toBe("2");
  });

  it("explicit --speed opts out of the default-path resample too (raw pacing requested)", () => {
    const out = join(dir, "def60raw");
    const res = render({ input: clip60, out, target: "voxel3d", width: 16, height: 16, wall: true, speedTicks: 1 });
    expect(res.frameCount).toBeGreaterThan(30); // every decoded frame kept
    expect(res.notes.join("\n")).not.toMatch(/resampled/);
    expect(speedOf(out)).toBe("1");
  });
});

if (ok) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
