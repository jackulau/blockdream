import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid } from "../src/depth";
import { framesToAnimated3d } from "../src/video3d";
import { EMPTY, type VoxelVolume } from "../src/volume";

// Shape-from-shading carves INTERNAL relief into the silhouette dome from per-pixel luminance, so a
// subject gains structure instead of inflating into one featureless dome — while the silhouette
// envelope (subject isolation, edge taper) and faithfulness (every subject pixel keeps >=1 voxel)
// are preserved. These specs pin all three.

// a centred filled square (id 5) on background (id 0). Centred → left-right MIRROR SYMMETRY, so two
// mirror columns have an identical silhouette envelope and differ only by whatever shading we apply.
function centeredSquare(size: number, side: number, id = 5): QuantizedFrame {
  const lo = (size - side) >> 1;
  const hi = lo + side;
  const ids = new Array(size * size).fill(0);
  for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) ids[y * size + x] = id;
  return { width: size, height: size, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) };
}

// number of solid voxels in the column above image pixel (ix, iy)
function columnDepth(v: VoxelVolume, ix: number, iy: number): number {
  const wy = v.sy - 1 - iy;
  let n = 0;
  for (let z = 0; z < v.sz; z++) if (v.data[ix + v.sx * (wy + v.sy * z)] !== EMPTY) n++;
  return n;
}

describe("shape-from-shading depth", () => {
  const size = 24;
  const side = 16; // centred square spans cols/rows [4,20); mirror axis at x = 11.5 → col 6 <-> col 17
  const frame = centeredSquare(size, side);
  const yMid = 12;
  const left = 6;
  const right = 17; // mirror of 6

  it("without shading, mirror-symmetric columns have equal depth (pure envelope)", () => {
    const flat = imageToSolid(frame, { maxDepth: 16 });
    expect(columnDepth(flat, left, yMid)).toBe(columnDepth(flat, right, yMid));
  });

  it("with shading, a brighter pixel is deeper than an equally-shaped darker one", () => {
    // luminance ramp: dark at the left edge of the square (x=4) → bright at the right (x=19)
    const shadingOf = (x: number, _y: number) => (x - 4) / (19 - 4);
    const lit = imageToSolid(frame, { maxDepth: 16, shadingOf, shadingGain: 1 });
    const dl = columnDepth(lit, left, yMid); // darker
    const dr = columnDepth(lit, right, yMid); // brighter, same envelope
    expect(dr).toBeGreaterThan(dl);
  });

  it("FAITHFULNESS: every subject pixel keeps >=1 voxel even at full gain over a fully-dark region", () => {
    const lit = imageToSolid(frame, { maxDepth: 16, shadingOf: () => 0, shadingGain: 1 });
    const lo = (size - side) >> 1;
    for (let iy = lo; iy < lo + side; iy++)
      for (let ix = lo; ix < lo + side; ix++) expect(columnDepth(lit, ix, iy)).toBeGreaterThanOrEqual(1);
  });

  it("a real depth map (depthOf) OVERRIDES shading — shading is ignored when both are set", () => {
    const depthOf = (x: number, _y: number) => (x < size / 2 ? 1 : 0.25);
    const withShade = imageToSolid(frame, { maxDepth: 16, depthOf, shadingOf: (x) => x / size, shadingGain: 1 });
    const without = imageToSolid(frame, { maxDepth: 16, depthOf });
    expect(Array.from(withShade.data)).toEqual(Array.from(without.data)); // byte-identical
  });

  it("video path: shadingForFrame carves the same per-frame relief (brighter = deeper)", () => {
    const vols = framesToAnimated3d([frame, frame], {
      maxDepth: 16,
      smooth: 0,
      shadingForFrame: (_f, x) => (x - 4) / (19 - 4),
      shadingGain: 1,
    });
    const v = vols[0]!;
    expect(columnDepth(v, right, yMid)).toBeGreaterThan(columnDepth(v, left, yMid));
  });
});
