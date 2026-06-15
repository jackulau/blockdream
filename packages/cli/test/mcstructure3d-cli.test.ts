// CLI-level proof of the mcstructure3d target: `blockdream render --target mcstructure3d`
// emits a TRUE 3D Bedrock .mcstructure (depth > 1) built by the voxel pipeline, with a sane
// placeable block palette - surfacing the previously dead-code buildVoxelMcStructure.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { readMcStructure } from "@blockdream/emit-bedrock";
import { render } from "../src/render";
import { runCli } from "../src/cli";

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let gif: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-mcs3d-"));
  gif = join(dir, "clip.gif");
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=0.5", "-y", gif]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

d("render --target mcstructure3d", () => {
  it("emits a true 3D .mcstructure with depth > 1 and a placeable block palette", () => {
    const out = join(dir, "m3d");
    const res = render({ input: gif, out, target: "mcstructure3d", width: 24, height: 24, maxFrames: 2, depth: 6 });
    expect(res.filesWritten.some((f) => f.endsWith(".mcstructure"))).toBe(true);
    expect(res.notes.join(" ")).toContain("3D");

    const file = res.filesWritten.find((f) => f.endsWith(".mcstructure"))!;
    const parsed = readMcStructure(readFileSync(file));
    const [w, h, depth] = parsed.size;
    expect(w).toBeGreaterThan(1);
    expect(h).toBeGreaterThan(1);
    expect(depth).toBeGreaterThan(1); // TRUE 3D - not the flat 1-thick wall

    // palette: air + real namespaced solid blocks (the solid-block resolver output)
    expect(parsed.blockNames).toContain("minecraft:air");
    const solids = parsed.blockNames.filter((n: string) => n !== "minecraft:air");
    expect(solids.length).toBeGreaterThan(0);
    for (const n of solids) expect(n).toMatch(/^minecraft:[a-z0-9_]+$/);
    // sanity: some voxels actually reference solid palette entries
    const airIdx = parsed.blockNames.indexOf("minecraft:air");
    expect(parsed.indices.some((i: number) => i !== airIdx)).toBe(true);
  });

  it("is reachable through the real CLI arg parser", () => {
    const out = join(dir, "m3d-cli");
    const code = runCli(["render", gif, "--target", "mcstructure3d", "--grid", "16x16", "--max-frames", "1", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "model3d.mcstructure"))).toBe(true);
  });
});
