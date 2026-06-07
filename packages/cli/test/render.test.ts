import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { render } from "../src/render";
import { runCli } from "../src/cli";

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-cli-"));
  gif = join(dir, "clip.gif");
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=1", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

function countFrameFunctions(packDir: string, ns: string): number {
  const fdir = join(packDir, "data", ns, "function", "frames");
  if (!existsSync(fdir)) return 0;
  return readdirSync(fdir).filter((f) => f.endsWith(".mcfunction")).length;
}

d("render() end-to-end", () => {
  it("datapack: emits pack.mcmeta and one frame function per input frame", () => {
    const out = join(dir, "dp");
    const res = render({ input: gif, out, target: "datapack", width: 16, height: 16, maxFrames: 4 });
    expect(res.frameCount).toBe(4);
    const meta = JSON.parse(readFileSync(join(out, "pack.mcmeta"), "utf8"));
    expect(meta.pack.pack_format).toBe(48);
    expect(countFrameFunctions(out, "blockdream")).toBe(4);
  });

  it("voxel3d: emits an animated 3D voxel datapack + zip from video frames", () => {
    const out = join(dir, "v3d");
    const res = render({ input: gif, out, target: "voxel3d", width: 16, height: 16, maxFrames: 3, depth: 6 });
    expect(res.frameCount).toBe(3);
    expect(existsSync(join(out, "pack.mcmeta"))).toBe(true);
    expect(existsSync(join(out, "blockdream_3d.zip"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(out, "pack.mcmeta"), "utf8"));
    expect(meta.pack.pack_format).toBeGreaterThan(0);
  });

  it("behaviorpack: emits a valid manifest.json", () => {
    const out = join(dir, "bp");
    const res = render({ input: gif, out, target: "behaviorpack", width: 16, height: 16, maxFrames: 3 });
    expect(res.frameCount).toBe(3);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(m.format_version).toBe(2);
    expect(m.modules[0].type).toBe("data");
  });

  it("map: emits a gzipped .dat per frame (128-multiple grid)", () => {
    const out = join(dir, "map");
    const res = render({ input: gif, out, target: "map", width: 128, height: 128, maxFrames: 2, edition: "java" });
    expect(res.filesWritten.length).toBe(2);
    const dat = readFileSync(res.filesWritten[0]!);
    expect(dat[0]).toBe(0x1f); // gzip magic
  });

  it("mcstructure: emits a structure file", () => {
    const out = join(dir, "mcs");
    const res = render({ input: gif, out, target: "mcstructure", width: 12, height: 12, maxFrames: 1 });
    expect(res.filesWritten.length).toBe(1);
    expect(res.filesWritten[0]!.endsWith(".mcstructure")).toBe(true);
  });

  it("map target rejects non-128-multiple grids", () => {
    expect(() => render({ input: gif, out: join(dir, "bad"), target: "map", width: 100, height: 100, maxFrames: 1 })).toThrow();
  });
});

d("runCli()", () => {
  it("returns 0 and writes a datapack for a real gif", () => {
    const out = join(dir, "cli-dp");
    const code = runCli(["render", gif, "--target", "datapack", "--grid", "16x16", "--max-frames", "3", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "pack.mcmeta"))).toBe(true);
  });

  it("returns nonzero on unknown target", () => {
    expect(runCli(["render", gif, "--target", "bogus", "--out", join(dir, "x")])).toBe(2);
  });

  it("prints usage and returns 1 with no input", () => {
    expect(runCli(["render"])).toBe(1);
  });
});

if (ff) process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
