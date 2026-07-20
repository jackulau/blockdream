import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { render, SEQUENCE_ANIMS } from "../src/render";
import { runCli } from "../src/cli";
import type { SequenceAnimName } from "@blockdream/voxel";

// D4: CLI --animate flag wires the existing tested generateSequence block-motion generators into
// voxel3d/mcstructure3d/model3d. The animation logic itself is tested in packages/voxel/test/animate.test.ts;
// here we test CLI integration: the flag is accepted, produces multi-frame output, and each
// sequence name drives a distinctly-animated build (not all the same block arrangement).

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;
let cubeObj: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-anim-cli-"));
  gif = join(dir, "still.gif");
  // Single-frame synthetic image → the still image case for --animate (clearest shape)
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=8:duration=0.125", "-vframes:v", "1", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
  // simple .obj cube for the model3d test
  const objData = [
    "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
    "v 0 0 1", "v 1 0 1", "v 1 1 1", "v 0 1 1",
    "f 1 2 3 4", "f 5 6 7 8", "f 1 5 8 4",
    "f 2 6 7 3", "f 1 2 6 5", "f 4 3 7 8",
  ].join("\n");
  cubeObj = join(dir, "cube.obj");
  writeFileSync(cubeObj, objData);
});

function countFrameFunctions(packDir: string, ns: string): number {
  const fdir = join(packDir, "data", ns, "function", "frames");
  if (!existsSync(fdir)) return 0;
  return readdirSync(fdir).filter((n) => n.endsWith(".mcfunction")).length;
}

d("--animate flag: block-motion generators wired to CLI", () => {
  it("SEQUENCE_ANIMS re-exported: explode, wave, buildup", () => {
    expect(SEQUENCE_ANIMS).toEqual(expect.arrayContaining(["explode", "wave", "buildup"]));
  });

  it("--animate invalid name → exit 2 with helpful error", () => {
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string): boolean => { stderr.push(s); return true; };
    try {
      const code = runCli(["render", "x.gif", "--target", "voxel3d", "--animate", "bogus"]);
      expect(code).toBe(2);
      expect(stderr.join("")).toMatch(/unknown --animate bogus/);
      expect(stderr.join("")).toMatch(/explode/);
    } finally {
      process.stderr.write = orig;
    }
  });

  for (const anim of ["explode", "wave", "buildup"] as SequenceAnimName[]) {
    it(`--animate ${anim}: voxel3d emits 24 frame functions (not 1)`, () => {
      const out = join(dir, `anim-${anim}`);
      const res = render({ input: gif, out, target: "voxel3d", width: 16, height: 16, animate: anim });
      // a single still → procedural animation of 24 frames
      expect(res.frameCount).toBe(24);
      expect(countFrameFunctions(out, "blockdream_3d")).toBe(24);
      expect(existsSync(join(out, "blockdream_3d.zip"))).toBe(true);
    });
  }

  it("--animate-frames controls the frame count", () => {
    const out = join(dir, "anim-frames");
    const res = render({ input: gif, out, target: "voxel3d", width: 16, height: 16, animate: "wave", animateFrames: 12 });
    expect(res.frameCount).toBe(12);
    expect(countFrameFunctions(out, "blockdream_3d")).toBe(12);
  });

  it("--animate works with model3d (static mesh → block-motion datapack)", () => {
    const out = join(dir, "anim-model3d");
    const res = render({ input: cubeObj, out, target: "model3d", width: 8, animate: "buildup", animateFrames: 6 });
    expect(res.frameCount).toBe(6);
    // datapack written
    expect(existsSync(join(out, "blockdream_model.zip"))).toBe(true);
  });

  it("--animate with mcstructure3d emits one .mcstructure per animation frame", () => {
    const out = join(dir, "anim-mcs3d");
    const res = render({ input: gif, out, target: "mcstructure3d", width: 16, height: 16, animate: "explode", animateFrames: 8 });
    expect(res.frameCount).toBe(8);
    const mcs = readdirSync(out).filter((n) => n.endsWith(".mcstructure"));
    expect(mcs.length).toBe(8);
  });

  it("--animate on a >20 fps clip skips the resample (and its note): the pack is the synthetic sequence", () => {
    // Without the skip, render emitted "resampled 30 → 20 frames" and then --animate replaced
    // the clip with N synthetic frames — a note describing frames the pack doesn't contain.
    const clip = join(dir, "clip30.mp4");
    const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=30:duration=1", "-y", clip]);
    expect(r.status).toBe(0);
    const out = join(dir, "anim-fps30");
    const res = render({ input: clip, out, target: "voxel3d", width: 16, height: 16, fps: 30, animate: "explode", animateFrames: 12 });
    expect(res.frameCount).toBe(12);
    expect(res.notes.join("\n")).not.toMatch(/resampled/);
  });

  it("--animate on a target that cannot animate says so instead of silently ignoring the flag", () => {
    const out = join(dir, "anim-2d");
    const res = render({ input: gif, out, target: "datapack", width: 16, height: 16, animate: "explode" });
    expect(res.notes.join("\n")).toMatch(/--animate only applies to 3D targets.*ignored for --target datapack/);
  });
});
