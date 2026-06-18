import { describe, it, expect } from "vitest";
import { preparePalette, quantizeFrame, createRgbImage, setPixel } from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette";
import { framesToAnimated3d, EMPTY, type VoxelVolume } from "@blockdream/voxel";

// D5 wiring: the CLI's voxel3d path derives a shape-from-shading signal from the QUANTIZED block's
// OKLab lightness — `pal.entries[q.paletteIndex[i]].lab.L` — and threads it as shadingForFrame. This
// exercises that EXACT derivation against the REAL solid-block palette (no ffmpeg needed), proving the
// luminance source is sound and the relief lands: a bright region builds deeper than an equally-shaped
// dark one, and turning shading off makes them equal again.

function columnDepth(v: VoxelVolume, ix: number, iy: number): number {
  const wy = v.sy - 1 - iy;
  let n = 0;
  for (let z = 0; z < v.sz; z++) if (v.data[ix + v.sx * (wy + v.sy * z)] !== EMPTY) n++;
  return n;
}

describe("CLI voxel3d shape-from-shading wiring", () => {
  const W = 32;
  const H = 32;
  const lo = 8;
  const hi = 24; // centred square [8,24); auto background-detection keeps it, removes the green border
  // green background + a centred square carrying a horizontal grayscale ramp (dark left → bright right)
  const img = createRgbImage(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (x >= lo && x < hi && y >= lo && y < hi) {
        const v = Math.round((255 * (x - lo)) / (hi - 1 - lo));
        setPixel(img, x, y, v, v, v);
      } else {
        setPixel(img, x, y, 0, 180, 0); // distinct uniform background
      }
    }
  const { palette } = getSolidBlockMapPalette();
  const pal = preparePalette(palette);
  const q = quantizeFrame(img, pal, { method: "none", gamutMap: 0.8 });
  // the EXACT signal render.ts voxel3d builds:
  const shadingForFrame = (_f: number, x: number, y: number) => pal.entries[q.paletteIndex[y * q.width + x]!]!.lab.L;

  const yMid = 16;
  const leftDark = lo + 2; // 10
  const rightBright = hi - 1 - 2; // 21 — mirror of 10 about the square centre → identical envelope

  it("the quantized luminance signal is a real gradient (dark left < bright right)", () => {
    const lumLeft = shadingForFrame(0, leftDark, yMid);
    const lumRight = shadingForFrame(0, rightBright, yMid);
    expect(lumRight).toBeGreaterThan(lumLeft + 0.1); // clear separation, not a flat field
  });

  it("with shading, the bright side builds deeper than the equally-shaped dark side", () => {
    const lit = framesToAnimated3d([q], { background: "none", maxDepth: 16, smooth: 0, shadingForFrame, shadingGain: 1 })[0]!;
    expect(columnDepth(lit, rightBright, yMid)).toBeGreaterThan(columnDepth(lit, leftDark, yMid));
  });

  it("with shading off (gain 0) the mirror columns are equal again (pure envelope)", () => {
    const flat = framesToAnimated3d([q], { background: "none", maxDepth: 16, smooth: 0, shadingGain: 0 })[0]!;
    expect(columnDepth(flat, rightBright, yMid)).toBe(columnDepth(flat, leftDark, yMid));
  });
});
