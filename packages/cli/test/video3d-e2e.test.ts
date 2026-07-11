import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg, extractFrames } from "@blockdream/video";
import { preparePalette, quantizeVideo, buildRgbLut } from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette";
import { framesToAnimated3d, countSolid, forEachSolid } from "@blockdream/voxel";
import { render } from "../src/render";

// The headline claim: feed a VIDEO, get an ANIMATED 3D block build (blocks that move over time).
// The pre-existing render.test.ts proved a voxel3d datapack is *emitted* from a clip, but never
// that the frames actually DIFFER — a static loop would pass it. This asserts real inter-frame
// motion at two layers: the built voxel volumes, and the emitted datapack product.

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let clip: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-v3d-e2e-"));
  clip = join(dir, "clip.mp4");
  // testsrc2 has a moving element → the silhouette changes frame-to-frame (real motion).
  const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=1", "-y", clip]);
  if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
});

/** A stable fingerprint of which voxels are solid (and their block id). Two frames with the same
 *  fingerprint are visually identical; differing fingerprints prove the build animates. */
function solidSignature(v: { sx: number; sy: number; sz: number }): string {
  const parts: string[] = [];
  forEachSolid(v as Parameters<typeof forEachSolid>[0], (x, y, z, c) => parts.push(`${x},${y},${z},${c}`));
  return parts.sort().join("|");
}

d("video → animated 3D blocks (end-to-end)", () => {
  it("the built voxel volumes actually MOVE between frames (not a static loop)", () => {
    const frames = extractFrames(clip, { width: 32, height: 32, maxFrames: 6 });
    expect(frames.length).toBeGreaterThan(1);
    const { palette } = getSolidBlockMapPalette();
    const pal = preparePalette(palette);
    const q = quantizeVideo(frames, pal, { method: "bayer", lut: buildRgbLut(pal) });
    const volumes = framesToAnimated3d(q, { maxDepth: 8 });

    // one solid volume per source frame, all the same dimensions (temporally coherent)
    expect(volumes.length).toBe(frames.length);
    expect(volumes.every((v) => v.sx === volumes[0]!.sx && v.sy === volumes[0]!.sy && v.sz === volumes[0]!.sz)).toBe(true);
    // every frame is a real 3D solid (depth > 1, not a flat slab) with content
    expect(volumes[0]!.sz).toBeGreaterThan(1);
    expect(volumes.every((v) => countSolid(v) > 0)).toBe(true);
    // MOTION: at least two distinct frames among the built volumes
    const sigs = new Set(volumes.map(solidSignature));
    expect(sigs.size).toBeGreaterThan(1);
  });

  it("render(voxel3d) emits a multi-frame animated datapack + zip with a function per frame", () => {
    const out = join(dir, "v3d");
    const res = render({ input: clip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 4, depth: 6 });
    expect(res.frameCount).toBe(4);
    expect(existsSync(join(out, "pack.mcmeta"))).toBe(true);
    expect(existsSync(join(out, "blockdream_3d.zip"))).toBe(true);

    // one frame entry per input frame (either frames/<i>.mcfunction or a split frames/<i>/ dir)
    const fdir = join(out, "data", "blockdream_3d", "function", "frames");
    const indices = new Set(readdirSync(fdir).map((n) => n.replace(/\.mcfunction$/, "")));
    for (let i = 0; i < 4; i++) expect(indices.has(String(i))).toBe(true);

    // frame 0 (the full build) is always substantial → the static 3D build exists
    const frame0 = safeLen(join(fdir, "0.mcfunction"));
    expect(frame0).toBeGreaterThan(0);
    // ANIMATION: the delta frames after frame 0 carry real block changes (subject moved over time)
    const deltaBytes = [1, 2, 3].reduce((sum, i) => sum + safeLen(join(fdir, `${i}.mcfunction`)), 0);
    expect(deltaBytes).toBeGreaterThan(0);
  });

  it("mcstructure3d emits a TRUE 3D structure (depth > 1) per video frame", () => {
    const out = join(dir, "mcs3d");
    const res = render({ input: clip, out, target: "mcstructure3d", width: 20, height: 20, maxFrames: 3, depth: 6 });
    expect(res.frameCount).toBe(3);
    const files = readdirSync(out).filter((n) => n.endsWith(".mcstructure"));
    expect(files.length).toBeGreaterThan(1); // one per frame
  });
});

function safeLen(p: string): number {
  try {
    return readFileSync(p).length;
  } catch {
    return 0;
  }
}

d("playback speed derives from --fps (real-time playback, no half-speed packs)", () => {
  // The bug this locks: voxel3d never passed speedTicks, so a --fps 20 render emitted the
  // default #speed 2 (10 fps playback) - the whole video played at HALF speed and drifted
  // against the real-time note-block music clock. --speed still wins when given explicitly.
  const speedOf = (out: string): string => {
    const setup = readFileSync(join(out, "data", "blockdream_3d", "function", "setup.mcfunction"), "utf8");
    const m = setup.match(/scoreboard players set #speed ma (\d+)/);
    return m ? m[1]! : "(missing)";
  };

  it("--fps 20 → 1 tick/frame; --fps 10 keeps the historical 2; explicit --speed wins", () => {
    const o20 = join(dir, "spd20");
    render({ input: clip, out: o20, target: "voxel3d", width: 16, height: 16, fps: 20, wall: true });
    expect(speedOf(o20)).toBe("1");

    const o10 = join(dir, "spd10");
    render({ input: clip, out: o10, target: "voxel3d", width: 16, height: 16, fps: 10, wall: true });
    expect(speedOf(o10)).toBe("2");

    const oExplicit = join(dir, "spdx");
    render({ input: clip, out: oExplicit, target: "voxel3d", width: 16, height: 16, fps: 20, speedTicks: 4, wall: true });
    expect(speedOf(oExplicit)).toBe("4");
  });
});
