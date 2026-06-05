import type { MapColor, MapPalette } from "@mineworld/palette";
import { srgbChannelToLinear, srgbToOklab, type Lab } from "./oklab";

/**
 * A palette prepared for fast nearest-color matching: each entry carries its
 * OKLab coordinates (for perceptual distance) and its linear-RGB coordinates
 * (for error-diffusion math).
 */
export interface PreparedColor {
  color: MapColor;
  lab: Lab;
  /** Linear-light RGB, each 0..1. */
  lin: [number, number, number];
}

export interface PreparedPalette {
  entries: PreparedColor[];
  version: string;
  edition: string;
}

export function preparePalette(p: MapPalette): PreparedPalette {
  return {
    version: p.version,
    edition: p.edition,
    entries: p.colors.map((color) => ({
      color,
      lab: srgbToOklab(color.r, color.g, color.b),
      lin: [
        srgbChannelToLinear(color.r),
        srgbChannelToLinear(color.g),
        srgbChannelToLinear(color.b),
      ],
    })),
  };
}

function labDist2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

export interface Match {
  index: number;
  color: MapColor;
  dist2: number;
}

/** Nearest palette color to an OKLab query (brute force over the palette). */
export function nearestByLab(query: Lab, pal: PreparedPalette): Match {
  let bestIdx = 0;
  let best = Infinity;
  for (let i = 0; i < pal.entries.length; i++) {
    const d = labDist2(query, pal.entries[i]!.lab);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { index: bestIdx, color: pal.entries[bestIdx]!.color, dist2: best };
}

/** Convenience: nearest palette color to an 8-bit sRGB triple. */
export function nearestSrgb(r: number, g: number, b: number, pal: PreparedPalette): Match {
  return nearestByLab(srgbToOklab(r, g, b), pal);
}

/**
 * Precomputed 3D RGB → palette-index lookup table for O(1) matching (the brute
 * force is O(palette) per pixel — the lag source for video). Each cell stores the
 * perceptually-nearest entry index, computed once via the OKLab matcher. `res`
 * cells per axis (33 → 8-bit-ish grid, ~36k cells); higher = more accurate.
 */
export interface RgbLut {
  res: number;
  table: Int32Array;
}

export function buildRgbLut(pal: PreparedPalette, res = 33): RgbLut {
  const table = new Int32Array(res * res * res);
  const step = 255 / (res - 1);
  let i = 0;
  for (let ri = 0; ri < res; ri++) {
    const r = ri * step;
    for (let gi = 0; gi < res; gi++) {
      const g = gi * step;
      for (let bi = 0; bi < res; bi++) {
        const b = bi * step;
        table[i++] = nearestByLab(srgbToOklab(r, g, b), pal).index;
      }
    }
  }
  return { res, table };
}

/** O(1) nearest-palette-index lookup for an 8-bit sRGB triple via the LUT. */
export function lutNearest(lut: RgbLut, r: number, g: number, b: number): number {
  const s = (lut.res - 1) / 255;
  const ri = Math.round((r < 0 ? 0 : r > 255 ? 255 : r) * s);
  const gi = Math.round((g < 0 ? 0 : g > 255 ? 255 : g) * s);
  const bi = Math.round((b < 0 ? 0 : b > 255 ? 255 : b) * s);
  return lut.table[(ri * lut.res + gi) * lut.res + bi]!;
}
