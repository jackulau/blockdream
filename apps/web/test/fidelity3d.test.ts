// ΔE2000-bounded proof that the 3D voxel path's color fidelity matches the 2D pixel-art
// standard. The 3D path quantizes in the PLACEABLE solid-block color space (~60 colors,
// one per base) while 2D uses the 244-color map-item palette — so 3D's perceptual error is
// necessarily higher, but it must stay within a bounded factor of the 2D path on the same
// source at the same resolution, and the volume's FRONT PROJECTION must carry exactly the
// quantized ids (preview == export, no second lossy step).
import { describe, it, expect } from "vitest";
import {
  preparePalette,
  quantizeFrame,
  deltaE2000Srgb,
  type RgbImage,
  type QuantizedFrame,
  type PreparedPalette,
} from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";
import javaMapPalette from "@blockdream/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@blockdream/palette";
import { imageToVolume, getVoxel, EMPTY } from "@blockdream/voxel";
import { resolveBlock } from "../src/resolve-block";

const SOLID = getSolidBlockMapPalette();
const pal3d = preparePalette(SOLID.palette);
const pal2d = preparePalette(javaMapPalette as unknown as MapPalette);

// photo-like synthetic source: smooth hue ramp × vertical luminance gradient + a saturated disc
function testImage(size: number): RgbImage {
  const data = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      const hue = x / size;
      const lum = 0.35 + 0.6 * (y / size);
      data[o] = Math.round(255 * lum * (0.5 + 0.5 * Math.sin(2 * Math.PI * hue)));
      data[o + 1] = Math.round(255 * lum * (0.5 + 0.5 * Math.sin(2 * Math.PI * (hue + 1 / 3))));
      data[o + 2] = Math.round(255 * lum * (0.5 + 0.5 * Math.sin(2 * Math.PI * (hue + 2 / 3))));
      const dx = x - size / 2;
      const dy = y - size / 2;
      if (dx * dx + dy * dy < (size * 0.18) ** 2) {
        data[o] = 220;
        data[o + 1] = 60;
        data[o + 2] = 40;
      }
    }
  return { width: size, height: size, data };
}

function meanDeltaE(src: RgbImage, q: QuantizedFrame, pal: PreparedPalette): number {
  let sum = 0;
  const n = q.width * q.height;
  for (let p = 0; p < n; p++) {
    const c = pal.entries[q.paletteIndex[p]!]!.color;
    const o = p * 3;
    sum += deltaE2000Srgb(src.data[o]!, src.data[o + 1]!, src.data[o + 2]!, c.r, c.g, c.b);
  }
  return sum / n;
}

describe("3D voxel path color fidelity vs the 2D pixel-art path", () => {
  const src = testImage(40);
  const q3d = quantizeFrame(src, pal3d, { method: "floyd-steinberg", gamutMap: 0.8 });

  it("3D perceptual error is bounded relative to the 2D standard (ΔE2000)", () => {
    // Per-pixel ΔE is method-sensitive (error diffusion trades per-pixel error for spatial
    // average), so compare like-for-like. Measured 2026-06-10: nearest e2d 5.72 / e3d 9.26;
    // floyd-steinberg e2d 9.84 / e3d 14.71 — the ~60-color placeable palette stays within
    // ~1.6× of the 244-color map palette on a saturated out-of-gamut source. Bound at 2.0×
    // + absolute caps with headroom; a broken matcher or palette regression blows past both.
    const eNearest2d = meanDeltaE(src, quantizeFrame(src, pal2d, { method: "none" }), pal2d);
    const eNearest3d = meanDeltaE(src, quantizeFrame(src, pal3d, { method: "none", gamutMap: 0.8 }), pal3d);
    expect(eNearest2d).toBeLessThan(8);
    expect(eNearest3d).toBeLessThan(Math.min(12, eNearest2d * 2.0));

    const eFs2d = meanDeltaE(src, quantizeFrame(src, pal2d, { method: "floyd-steinberg" }), pal2d);
    const eFs3d = meanDeltaE(src, q3d, pal3d);
    expect(eFs3d).toBeLessThan(Math.min(18, eFs2d * 2.0));
  });

  it("every 3D-quantized cell resolves to a placeable block (preview == export)", () => {
    const ids = new Set<number>();
    for (let p = 0; p < q3d.width * q3d.height; p++) ids.add(q3d.mapColorId[p]!);
    for (const id of ids) {
      const block = resolveBlock(id);
      expect(block, `mapColorId ${id} must place a real block`).not.toBe("minecraft:air");
      expect(SOLID.blockByMapColorId.get(id)?.id, `id ${id} round-trips through the emitter map`).toBe(block);
    }
  });

  it("the volume's front projection carries exactly the quantized ids (no second lossy step)", () => {
    const vol = imageToVolume(q3d, { mode: "flat", depth: 1 });
    for (let y = 0; y < q3d.height; y++)
      for (let x = 0; x < q3d.width; x++) {
        const v = getVoxel(vol, x, q3d.height - 1 - y, 0); // image row 0 = top = highest Y
        expect(v === EMPTY ? -1 : v).toBe(q3d.mapColorId[y * q3d.width + x]!);
      }
  });
});
