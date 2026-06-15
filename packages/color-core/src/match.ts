import type { MapColor, MapPalette } from "@blockdream/palette";
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
  /** OKLCh chroma = √(a²+b²). */
  chroma: number;
  /** OKLCh hue = atan2(b, a) in radians. */
  hue: number;
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
    entries: p.colors.map((color) => {
      const lab = srgbToOklab(color.r, color.g, color.b);
      return {
        color,
        lab,
        lin: [
          srgbChannelToLinear(color.r),
          srgbChannelToLinear(color.g),
          srgbChannelToLinear(color.b),
        ],
        chroma: Math.hypot(lab.a, lab.b),
        hue: Math.atan2(lab.b, lab.a),
      };
    }),
  };
}

/** Shortest angular distance between two hues (radians, 0..π). */
export function hueDistance(h1: number, h2: number): number {
  let d = Math.abs(h1 - h2) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
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
 * Gamut-mapped nearest match: OKLab distance plus a HUE penalty weighted by the
 * target's chroma. For saturated (out-of-gamut) inputs this keeps the source
 * HUE - picking a duller same-hue block instead of a closer-but-wrong-hue or
 * muddy-gray one. Neutral inputs (chroma→0) fall back to plain nearest, since
 * hue is meaningless there. `lambda` controls hue rigidity.
 */
export function nearestByLabHue(query: Lab, pal: PreparedPalette, lambda = 0.6): Match {
  const cT = Math.hypot(query.a, query.b);
  const hT = Math.atan2(query.b, query.a);
  let bestIdx = 0;
  let bestPenalty = Infinity;
  let bestDist2 = Infinity;
  for (let i = 0; i < pal.entries.length; i++) {
    const e = pal.entries[i]!;
    const dL = query.L - e.lab.L;
    const da = query.a - e.lab.a;
    const db = query.b - e.lab.b;
    const dist2 = dL * dL + da * da + db * db;
    const hd = hueDistance(hT, e.hue);
    const penalty = dist2 + lambda * cT * hd * hd;
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestIdx = i;
      bestDist2 = dist2;
    }
  }
  return { index: bestIdx, color: pal.entries[bestIdx]!.color, dist2: bestDist2 };
}

export function nearestSrgbHue(r: number, g: number, b: number, pal: PreparedPalette, lambda = 0.6): Match {
  return nearestByLabHue(srgbToOklab(r, g, b), pal, lambda);
}

/**
 * Precomputed 3D RGB → palette-index lookup table for O(1) matching (the brute
 * force is O(palette) per pixel - the lag source for video). Each cell stores the
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
