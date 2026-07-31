import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { runCli } from "../src/cli";
import { previewPng } from "../src/preview";

// Transparent spy: previewPng keeps its REAL implementation (the e2e tests below depend on it)
// but records its calls, so we can prove the CLI threads --version/--palette through to
// pickPalette instead of dropping them (D8c - preview never passed paletteVersion).
vi.mock("../src/preview", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/preview")>();
  return { ...mod, previewPng: vi.fn(mod.previewPng) };
});

// D5 (goal 087): the preview verb parseInt'd --grid with NO shape validation, so `--grid abc`
// became NaN, slipped past every downstream guard (NaN comparisons are all false), and died
// inside ffmpeg with a misdirected `scale=NaN:NaN` error. preview now shares render's --grid
// WxH validation and exits 2 BEFORE ffmpeg ever runs - these bad-flag cases are fully offline.

function captureRun(argv: string[]): { code: number; err: string } {
  const errs: string[] = [];
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    errs.push(String(s));
    return true;
  }) as typeof process.stderr.write);
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  try {
    return { code: runCli(argv), err: errs.join("") };
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("preview flag validation (offline: exits 2 before ffmpeg runs)", () => {
  it("--grid abc exits 2 with the shared WxH message (not an ffmpeg scale=NaN:NaN error)", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--grid", "abc"]);
    expect(code).toBe(2);
    expect(err).toContain("--grid must be WxH");
  });

  it("--grid 128 (bare number) exits 2: preview shares render's strict WxH shape", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--grid", "128"]);
    expect(code).toBe(2);
    expect(err).toContain("--grid must be WxH");
  });

  it("--grid 0x0 exits 2 (positive integers required)", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--grid", "0x0"]);
    expect(code).toBe(2);
    expect(err).toContain("--grid must be WxH");
  });

  it("--gamut x exits 2 naming the flag (previously NaN reached the quantizer silently)", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--gamut", "x"]);
    expect(code).toBe(2);
    expect(err).toContain("--gamut must be");
  });
});

// D8 (goal 088): preview returned BEFORE the shared flag checks, so `preview x --dither bogus`
// silently rendered floyd-steinberg while `render` exited 2 for the same flag; --palette typos
// silently coerced to map; --version was parsed but never passed to pickPalette.
describe("preview/render validation parity (offline)", () => {
  it("preview --dither bogus exits 2 (was: silently rendered floyd-steinberg)", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--dither", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown --dither bogus");
  });

  it("--palette bogus exits 2 (was: silently coerced to map)", () => {
    const { code, err } = captureRun(["preview", "missing.gif", "--palette", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown --palette bogus");
  });

  it("--palette bogus exits 2 on render too (shared check)", () => {
    const { code, err } = captureRun(["render", "missing.gif", "--palette", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown --palette bogus");
  });

  it("--version 9.99 exits 2 with the supported list (shared check, both verbs)", () => {
    const p = captureRun(["preview", "missing.gif", "--version", "9.99"]);
    expect(p.code).toBe(2);
    expect(p.err).toContain('unsupported Minecraft version "9.99"');
    const r = captureRun(["render", "missing.gif", "--version", "9.99"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unsupported Minecraft version "9.99"');
  });

  it("--version and --palette reach previewPng (and so pickPalette)", () => {
    vi.mocked(previewPng).mockClear();
    // fails INSIDE previewPng on the missing input (exit 1) - after the options were built
    const { code } = captureRun(["preview", "missing.gif", "--version", "1.21.4", "--palette", "block"]);
    expect(code).toBe(1);
    expect(vi.mocked(previewPng)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(previewPng).mock.calls[0]![1]).toMatchObject({ paletteVersion: "1.21.4", palette: "block" });
  });
});

// ---- good path (needs ffmpeg): the shared validation still lets a real preview through ----
const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-preview-cli-"));
  gif = join(dir, "still.gif");
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=0.125", "-frames:v", "1", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

d("preview end-to-end", () => {
  it("--grid 24x24 writes a side-by-side PNG and returns 0", () => {
    const out = join(dir, "preview.png");
    const code = runCli(["preview", gif, "--grid", "24x24", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const png = readFileSync(out);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  });

  it("--palette block changes the preview output vs the default map palette", () => {
    const mapOut = join(dir, "pal-map.png");
    const blockOut = join(dir, "pal-block.png");
    expect(runCli(["preview", gif, "--grid", "24x24", "--out", mapOut])).toBe(0);
    expect(runCli(["preview", gif, "--grid", "24x24", "--palette", "block", "--out", blockOut])).toBe(0);
    // 244 map colors vs the ~301-block build gamut quantize the same source differently
    expect(readFileSync(mapOut).equals(readFileSync(blockOut))).toBe(false);
  });
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
