import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { framesToAnimated3d } from "../src/video3d";
import { countSolid } from "../src/volume";

// goal 036 D8 (coverage): framesToAnimated3d is the function the CLI 3D path actually uses, but had no
// direct test. Lock: stable per-frame dims, a subject builds, and an all-background frame is handled
// gracefully (empty volume, no crash - the aggregate empty guard lives in the CLI).
function frame(w: number, h: number, fill: (x: number, y: number) => number): QuantizedFrame {
  const mapColorId = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mapColorId[y * w + x] = fill(x, y);
  return { width: w, height: h, mapColorId, paletteIndex: new Int32Array(w * h) };
}

// a centred subject (id 30) on a border background (id 2)
const subject = (x: number, y: number) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? 30 : 2);

describe("framesToAnimated3d", () => {
  it("returns one volume per frame, all the same size", () => {
    const vols = framesToAnimated3d([frame(8, 8, subject), frame(8, 8, subject)], { maxDepth: 4 });
    expect(vols.length).toBe(2);
    expect(vols.every((v) => v.sx === 8 && v.sy === 8 && v.sz === 4)).toBe(true);
  });

  it("builds solid voxels for a subject", () => {
    const [v] = framesToAnimated3d([frame(8, 8, subject)], { maxDepth: 6 });
    expect(countSolid(v!)).toBeGreaterThan(0);
  });

  it("an all-background frame yields an empty volume without crashing", () => {
    const vols = framesToAnimated3d([frame(8, 8, () => 6)], { maxDepth: 4 });
    expect(vols.length).toBe(1);
    expect(countSolid(vols[0]!)).toBe(0); // empty per-frame is OK; the CLI guards the aggregate
  });

  it("empty input returns no volumes", () => {
    expect(framesToAnimated3d([], { maxDepth: 4 })).toEqual([]);
  });
});
