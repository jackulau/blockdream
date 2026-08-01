import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { getJavaMapPalette } from "@blockdream/palette";
import {
  preparePalette,
  createRgbImage,
  setPixel,
  quantizeFrame,
  quantizeVideo,
  type RgbImage,
  type QuantizedFrame,
} from "@blockdream/color-core";
import { runCli } from "../src/cli";

// D7 (goal 089): quantize-flag honesty. Three silent no-ops and one library footgun:
//  (a) --dither floyd-steinberg + --temporal: hysteresis excludes error diffusion, so the
//      threshold did nothing, silently.
//  (b) a single still + --temporal: there is no previous frame to retain, quantizeAll drops
//      the threshold entirely, silently.
//  (c) --target rgbscreen never quantizes at all (TRUE-RGB), yet accepted --dither/--temporal/
//      --gamut without a word.
//  (d) quantizeVideo with temporalThreshold and NO method used to run plain-nearest hysteresis
//      while quantizeFrame's documented no-method default is floyd-steinberg: the still and
//      video quantizers disagreed on what "no method" means. Now aligned (safe: CLI and web
//      always pass an explicit method; no caller behavior changes).

function captureRun(argv: string[]): { code: number; err: string; out: string } {
  const errs: string[] = [];
  const outs: string[] = [];
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    errs.push(String(s));
    return true;
  }) as typeof process.stderr.write);
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
    outs.push(String(s));
    return true;
  }) as typeof process.stdout.write);
  try {
    return { code: runCli(argv), err: errs.join(""), out: outs.join("") };
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

// ---- (a) + (c): parse-time notes, offline (they print before render decodes anything) ----

describe("(a) --temporal with --dither floyd-steinberg warns (offline)", () => {
  it("floyd-steinberg + --temporal carries the note", () => {
    const { err } = captureRun(["render", "missing.gif", "--target", "datapack", "--dither", "floyd-steinberg", "--temporal", "0.002"]);
    expect(err).toContain("note: --temporal has no effect with --dither floyd-steinberg");
  });

  it("bayer + --temporal does NOT warn (hysteresis applies)", () => {
    const { err } = captureRun(["render", "missing.gif", "--target", "datapack", "--dither", "bayer", "--temporal", "0.002"]);
    expect(err).not.toContain("--temporal has no effect");
  });

  it("no --dither + --temporal does NOT warn (video default is bayer)", () => {
    const { err } = captureRun(["render", "missing.gif", "--target", "datapack", "--temporal", "0.002"]);
    expect(err).not.toContain("--temporal has no effect");
  });
});

describe("(c) rgbscreen ignores the quantization flags and says so (offline)", () => {
  for (const flags of [["--dither", "bayer"], ["--temporal", "0.002"], ["--gamut", "0.8"]]) {
    it(`${flags[0]} on rgbscreen carries the ignore-note`, () => {
      const { err } = captureRun(["render", "missing.gif", "--target", "rgbscreen", ...flags]);
      expect(err).toContain("note: --dither/--temporal/--gamut do not apply to --target rgbscreen");
    });
  }

  it("rgbscreen + floyd-steinberg + --temporal gets ONLY the rgbscreen note (no double warning)", () => {
    const { err } = captureRun(["render", "missing.gif", "--target", "rgbscreen", "--dither", "floyd-steinberg", "--temporal", "0.002"]);
    expect(err).toContain("do not apply to --target rgbscreen");
    expect(err).not.toContain("--temporal has no effect");
  });

  it("--dither/--gamut on a palette target does NOT warn (they are honored)", () => {
    const { err } = captureRun(["render", "missing.gif", "--target", "datapack", "--dither", "bayer", "--gamut", "0.8"]);
    expect(err).not.toContain("do not apply to --target rgbscreen");
  });
});

// ---- (b): the single-still note needs a real decode (frame count known only after) ----

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let still: string;
let clip: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "bd-quant-honesty-"));
  still = join(dir, "still.png");
  clip = join(dir, "clip.gif");
  let r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=1:duration=1", "-frames:v", "1", "-y", still]);
  if (r.status !== 0) throw new Error("ffmpeg still gen failed: " + r.stderr);
  r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=1", "-y", clip]);
  if (r.status !== 0) throw new Error("ffmpeg clip gen failed: " + r.stderr);
});

d("(b) single still + --temporal notes the drop", () => {
  it("a still image with --temporal renders with the ignored-note", () => {
    const { code, out } = captureRun(["render", still, "--target", "datapack", "--grid", "16x16", "--temporal", "0.002", "--out", join(dir, "still-out")]);
    expect(code).toBe(0);
    expect(out).toContain("--temporal only applies to multi-frame input - ignored for a single still.");
  });

  it("a multi-frame clip with --temporal does NOT carry the still-note", () => {
    const { code, out } = captureRun(["render", clip, "--target", "datapack", "--grid", "16x16", "--max-frames", "3", "--temporal", "0.002", "--out", join(dir, "clip-out")]);
    expect(code).toBe(0);
    expect(out).not.toContain("--temporal only applies to multi-frame input");
  });
});

// ---- (d): quantizeVideo's no-method default now matches quantizeFrame (floyd-steinberg) ----

const pal = preparePalette(getJavaMapPalette());

function noise(seed: number, w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) % 256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, rnd(), rnd(), rnd());
  return img;
}

function expectElementIdentical(a: QuantizedFrame, b: QuantizedFrame): void {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let mismatches = 0;
  for (let i = 0; i < a.paletteIndex.length; i++) {
    if (a.paletteIndex[i] !== b.paletteIndex[i] || a.mapColorId[i] !== b.mapColorId[i]) mismatches++;
  }
  expect(mismatches).toBe(0);
}

describe("(d) quantizeVideo no-method default aligns with quantizeFrame", () => {
  const img = noise(7, 32, 32);

  it("no method + temporalThreshold takes the per-frame floyd-steinberg path", () => {
    const video = quantizeVideo([img, img], pal, { temporalThreshold: 0.002 });
    const stillDefault = quantizeFrame(img, pal, {}); // documented default: floyd-steinberg
    expectElementIdentical(video[0]!, stillDefault);
    expectElementIdentical(video[1]!, stillDefault);
  });

  it("the alignment is not vacuous: the old plain-nearest hysteresis output differs", () => {
    const noMethod = quantizeVideo([img, img], pal, { temporalThreshold: 0.002 });
    const oldPath = quantizeVideo([img, img], pal, { method: "none", temporalThreshold: 0.002 });
    let diffs = 0;
    for (let i = 0; i < noMethod[0]!.mapColorId.length; i++) {
      if (noMethod[0]!.mapColorId[i] !== oldPath[0]!.mapColorId[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it("no method + NO threshold is unchanged (per-frame floyd, same as before)", () => {
    const video = quantizeVideo([img], pal, {});
    expectElementIdentical(video[0]!, quantizeFrame(img, pal, {}));
  });
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
