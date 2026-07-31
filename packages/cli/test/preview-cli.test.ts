import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { runCli } from "../src/cli";

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
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
