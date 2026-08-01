import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { readMcStructure } from "@blockdream/emit-bedrock";
import { runCli } from "../src/cli";

// D6 (goal 089): --origin/--facing on the 2D targets. The 3D + rgbscreen targets always threaded
// --origin, but the 2D wall emitters (datapack/behaviorpack/bedrock-script) dropped it on the
// floor with exit 0: `--origin 100,70,-50` still force-loaded and built at 0,64,0. Every 2D
// target must now either HONOR the flag in its emitted commands or say on stderr that it is
// ignored - no silent drops.

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

// ---- offline: the ignore-notes print before render(), so a missing input still exercises them ----

describe("--facing ignore-note (offline): warned wherever no emitter can honor it", () => {
  for (const target of ["datapack", "behaviorpack", "bedrock-script", "mcstructure", "map", "mwframes"]) {
    it(`--facing on ${target} carries the ignore-note`, () => {
      const { err } = captureRun(["render", "missing.gif", "--target", target, "--facing", "east"]);
      expect(err).toContain("note: --facing applies only to --target voxel3d|mcstructure3d|model3d|rgbscreen");
      expect(err).toContain(`ignored for ${target}`);
    });
  }
  for (const target of ["voxel3d", "mcstructure3d", "model3d", "rgbscreen"]) {
    it(`--facing on ${target} does NOT warn (it is honored)`, () => {
      const { err } = captureRun(["render", "missing.gif", "--target", target, "--facing", "east"]);
      expect(err).not.toContain("--facing applies only");
    });
  }
});

describe("--origin ignore-note (offline): only the map-item targets have no world position", () => {
  for (const target of ["map", "mwframes"]) {
    it(`--origin on ${target} carries the ignore-note`, () => {
      const { err } = captureRun(["render", "missing.gif", "--target", target, "--origin", "100,70,-50"]);
      expect(err).toContain("note: --origin does not apply to --target map|mwframes");
      expect(err).toContain(`ignored for ${target}`);
    });
  }
  for (const target of ["datapack", "behaviorpack", "bedrock-script", "mcstructure", "voxel3d", "rgbscreen"]) {
    it(`--origin on ${target} does NOT warn (it is honored)`, () => {
      const { err } = captureRun(["render", "missing.gif", "--target", target, "--origin", "100,70,-50"]);
      expect(err).not.toContain("--origin does not apply");
    });
  }
});

// ---- e2e through a real render: the emitted commands actually move to the origin ----

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;
const O = "100,70,-50";
// 16x16 grid at origin 100,70,-50: x spans 100..115, y spans 70..85, z is the -50 plane
const ORIGIN_ARGS = ["--grid", "16x16", "--max-frames", "2", "--origin", O] as const;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "bd-origin2d-"));
  gif = join(dir, "clip.gif");
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=1", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

/** First-triple anchors of every setblock/fill across the .mcfunction frame files. */
function frameAnchors(root: string, framesGlobDir: string): Array<{ x: number; y: number; z: number }> {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: Array<{ x: number; y: number; z: number }> = [];
  const walk = (p: string): void => {
    for (const e of readdirSync(p)) {
      const f = join(p, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (f.endsWith(".mcfunction")) {
        for (const m of readFileSync(f, "utf8").matchAll(/^(?:setblock|fill) (-?\d+) (-?\d+) (-?\d+)/gm)) {
          out.push({ x: +m[1]!, y: +m[2]!, z: +m[3]! });
        }
      }
    }
  };
  walk(join(root, framesGlobDir));
  return out;
}

d("datapack honors --origin (Java 2D wall)", () => {
  it("setup force-loads the origin plane and frame 0 builds at the origin corner", () => {
    const out = join(dir, "dp-origin");
    const code = runCli(["render", gif, "--target", "datapack", ...ORIGIN_ARGS, "--out", out]);
    expect(code).toBe(0);
    const setup = readFileSync(join(out, "data", "blockdream", "function", "setup.mcfunction"), "utf8");
    expect(setup).toContain("forceload add 100 -50 115 -50");
    const anchors = frameAnchors(out, join("data", "blockdream", "function", "frames"));
    expect(anchors.length).toBeGreaterThan(0);
    // frame 0 is a keyframe (every cell placed), so the full grid extent is present
    expect(Math.min(...anchors.map((a) => a.x))).toBe(100);
    expect(Math.max(...anchors.map((a) => a.x))).toBe(115);
    expect(Math.min(...anchors.map((a) => a.y))).toBe(70);
    expect(Math.max(...anchors.map((a) => a.y))).toBe(85);
    expect(anchors.every((a) => a.z === -50)).toBe(true);
  });

  it("no --origin keeps the documented 0,64,0 default (regression guard)", () => {
    const out = join(dir, "dp-default");
    const code = runCli(["render", gif, "--target", "datapack", "--grid", "16x16", "--max-frames", "2", "--out", out]);
    expect(code).toBe(0);
    const setup = readFileSync(join(out, "data", "blockdream", "function", "setup.mcfunction"), "utf8");
    expect(setup).toContain("forceload add 0 0 15 0");
  });
});

d("behaviorpack honors --origin (Bedrock 2D wall)", () => {
  it("setup ticks the origin area and frames build there", () => {
    const out = join(dir, "bp-origin");
    const code = runCli(["render", gif, "--target", "behaviorpack", ...ORIGIN_ARGS, "--out", out]);
    expect(code).toBe(0);
    const setup = readFileSync(join(out, "functions", "blockdream", "setup.mcfunction"), "utf8");
    expect(setup).toContain("tickingarea add 100 70 -50 115 85 -50");
    const anchors = frameAnchors(out, join("functions", "blockdream", "frames"));
    expect(anchors.length).toBeGreaterThan(0);
    expect(Math.min(...anchors.map((a) => a.x))).toBe(100);
    expect(Math.min(...anchors.map((a) => a.y))).toBe(70);
    expect(anchors.every((a) => a.z === -50)).toBe(true);
  });
});

d("bedrock-script honors --origin (Script-API addon)", () => {
  it("the POOL data module carries the origin", () => {
    const out = join(dir, "bs-origin");
    const code = runCli(["render", gif, "--target", "bedrock-script", ...ORIGIN_ARGS, "--out", out]);
    expect(code).toBe(0);
    const framesJs = readFileSync(join(out, "behavior_pack", "scripts", "frames.js"), "utf8");
    expect(framesJs).toContain('"origin":{"x":100,"y":70,"z":-50}');
  });
});

d("mcstructure honors --origin (already threaded; locked here with the rest of the 2D set)", () => {
  it("structure_world_origin equals the supplied origin", () => {
    const out = join(dir, "ms-origin");
    const code = runCli(["render", gif, "--target", "mcstructure", ...ORIGIN_ARGS, "--out", out]);
    expect(code).toBe(0);
    const buf = readFileSync(join(out, "frame_0.mcstructure"));
    expect(readMcStructure(buf).origin).toEqual([100, 70, -50]);
  });
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
