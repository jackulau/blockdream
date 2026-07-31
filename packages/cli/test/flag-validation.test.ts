import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { runCli } from "../src/cli";

// D1 (goal 087): every numeric flag is validated at the parse boundary. Before this, a bad value
// flowed through raw Number() as NaN, survived every `?? default` (NaN is not nullish), and
// `--speed x` reached the emitted datapack as `scoreboard players set #speed ma NaN` with EXIT 0
// - silent corruption. A bad flag must exit 2 with a message naming the flag, before any emit.

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

describe("numeric flag validation (offline: exits 2 before any decode or emit)", () => {
  // [flag, bad value] - each violates the flag's documented constraint a different way
  const BAD: Array<[string, string]> = [
    ["fps", "x"],
    ["fps", "0"],
    ["fps", "-5"],
    ["max-frames", "x"],
    ["max-frames", "-1"],
    ["max-frames", "1.5"],
    ["temporal", "x"],
    ["temporal", "-0.1"],
    ["speed", "x"],
    ["speed", "0"],
    ["speed", "1.5"],
    ["depth", "x"],
    ["depth", "0"],
    ["smooth", "x"],
    ["smooth", "1.5"],
    ["smooth", "-0.1"],
    ["curve", "x"],
    ["curve", "0"],
    ["shading", "x"],
    ["shading", "2"],
    ["gamut", "x"],
    ["gamut", "-1"],
    ["animate-frames", "x"],
    ["animate-frames", "0"],
    ["animate-frames", "2.5"],
  ];
  for (const [flag, value] of BAD) {
    it(`--${flag} ${value} exits 2 with a message naming the flag`, () => {
      // input never decoded: validation fires before render(), so a missing file is fine
      const { code, err } = captureRun(["render", "missing.gif", "--target", "datapack", `--${flag}`, value]);
      expect(code).toBe(2);
      expect(err).toContain(`--${flag} must be`);
    });
  }

  it("reports EVERY bad numeric flag in one run (not just the first)", () => {
    const { code, err } = captureRun(["render", "missing.gif", "--fps", "x", "--speed", "y"]);
    expect(code).toBe(2);
    expect(err).toContain("--fps must be");
    expect(err).toContain("--speed must be");
  });

  it("boundary values stay valid: --shading 0 and --smooth 1 pass flag parsing", () => {
    // both fail LATER at render() (missing input) with exit 1 - not exit 2 at the flag boundary
    const zero = captureRun(["render", "missing.gif", "--target", "voxel3d", "--shading", "0", "--smooth", "1"]);
    expect(zero.code).toBe(1);
    expect(zero.err).not.toContain("must be");
  });
});

// ---- regression through a real render: valid --speed reaches the pack, bad --speed never emits --
const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-flagval-"));
  gif = join(dir, "clip.gif");
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=1", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

d("--speed end-to-end (the NaN-corruption regression)", () => {
  it("valid --speed 3 stamps an integer `#speed ma 3` into the datapack setup (no NaN)", () => {
    const out = join(dir, "spd-ok");
    const code = runCli(["render", gif, "--target", "datapack", "--grid", "16x16", "--max-frames", "2", "--speed", "3", "--out", out]);
    expect(code).toBe(0);
    const setup = readFileSync(join(out, "data", "blockdream", "function", "setup.mcfunction"), "utf8");
    expect(setup).toContain("scoreboard players set #speed ma 3");
    expect(setup).not.toContain("NaN");
  });

  it("--speed x exits 2 BEFORE any emit (nothing written)", () => {
    const out = join(dir, "spd-bad");
    const { code, err } = captureRun(["render", gif, "--target", "datapack", "--grid", "16x16", "--speed", "x", "--out", out]);
    expect(code).toBe(2);
    expect(err).toContain("--speed must be");
    expect(existsSync(out)).toBe(false);
  });
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
