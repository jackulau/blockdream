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
  /**
   * Entries sorted ascending by OKLab L, stored as THREE SEPARATE arrays (L, a, b) rather than
   * one interleaved array. The L-only check `dL*dL >= best` in the band-prune walk only touches
   * `sortedL` — with a separate array all 244 L values (244*8 = 1952 bytes) fit in L1 cache and
   * are stride-1 sequential, which is ~1.5x faster than the interleaved layout where L values are
   * 24 bytes apart and fill only 1/3 of each cache line. `sortedA` and `sortedB` are accessed only
   * for entries that pass the band check. `sortedOrigIdx` maps each sorted position to its original
   * `entries` index for the tie-break and result lookup.
   */
  sortedL: Float64Array;
  sortedA: Float64Array;
  sortedB: Float64Array;
  sortedOrigIdx: Int32Array;
}

export function preparePalette(p: MapPalette): PreparedPalette {
  const entries: PreparedColor[] = p.colors.map((color) => {
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
  });

  // Build the L-sorted acceleration structure. Sort by L; on ties keep the lower original index so
  // the walk visits equal-L entries in original order (the matchers also tie-break by lowest index,
  // so the chosen index is identical to a plain index-order brute force).
  const order = entries.map((_, i) => i).sort((a, b) => entries[a]!.lab.L - entries[b]!.lab.L || a - b);
  const n = entries.length;
  const sortedL = new Float64Array(n);
  const sortedA = new Float64Array(n);
  const sortedB = new Float64Array(n);
  const sortedOrigIdx = new Int32Array(n);
  for (let p2 = 0; p2 < order.length; p2++) {
    const k = order[p2]!;
    const lab = entries[k]!.lab;
    sortedL[p2] = lab.L;
    sortedA[p2] = lab.a;
    sortedB[p2] = lab.b;
    sortedOrigIdx[p2] = k;
  }

  return { version: p.version, edition: p.edition, entries, sortedL, sortedA, sortedB, sortedOrigIdx };
}

/** Insertion point for `L` in the L-sorted entries: lowest index p with sortedL[p] >= L. */
function lowerBoundL(pal: PreparedPalette, L: number): number {
  const sL = pal.sortedL;
  let lo = 0;
  let hi = pal.sortedOrigIdx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sL[mid]! < L) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Shortest angular distance between two hues (radians, 0..π). */
export function hueDistance(h1: number, h2: number): number {
  let d = Math.abs(h1 - h2) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

export interface Match {
  index: number;
  color: MapColor;
  dist2: number;
}

/**
 * Nearest palette color to an OKLab query. Exact, but accelerated by the L-sorted band prune:
 * binary-search to the query's L, walk both ways, stop a side once (dL*dL) >= best (any further
 * entry on that side is at least that far in L alone). Byte-identical to a plain index-order brute
 * force — the prune never skips a closer-or-equal entry, and ties resolve to the lowest original
 * index (so the result matches scanning entries[0..n) and keeping the first minimum).
 */
export function nearestByLab(query: Lab, pal: PreparedPalette): Match {
  const sL = pal.sortedL;
  const sA = pal.sortedA;
  const sB = pal.sortedB;
  const oi = pal.sortedOrigIdx;
  const n = oi.length;
  const start = lowerBoundL(pal, query.L);
  let bestIdx = 0;
  let best = Infinity;
  for (let p = start; p < n; p++) {
    const dL = sL[p]! - query.L;
    if (dL * dL >= best) break;
    const da = sA[p]! - query.a;
    const db = sB[p]! - query.b;
    const d = dL * dL + da * da + db * db;
    const k = oi[p]!;
    if (d < best || (d === best && k < bestIdx)) {
      best = d;
      bestIdx = k;
    }
  }
  for (let p = start - 1; p >= 0; p--) {
    const dL = query.L - sL[p]!;
    if (dL * dL >= best) break;
    const da = sA[p]! - query.a;
    const db = sB[p]! - query.b;
    const d = dL * dL + da * da + db * db;
    const k = oi[p]!;
    if (d < best || (d === best && k < bestIdx)) {
      best = d;
      bestIdx = k;
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
  const sL = pal.sortedL;
  const sA = pal.sortedA;
  const sB = pal.sortedB;
  const oi = pal.sortedOrigIdx;
  const n = oi.length;
  const start = lowerBoundL(pal, query.L);
  let bestIdx = 0;
  let bestPenalty = Infinity;
  let bestDist2 = Infinity;
  // The L-band prune is exact here too: penalty = dist2 + (>=0) >= dist2 >= dL*dL, so once
  // dL*dL >= bestPenalty no further same-side entry can lower the penalty. Tie-break to the lowest
  // original index, matching a plain index-order brute force.
  for (let p = start; p < n; p++) {
    const dL = sL[p]! - query.L;
    if (dL * dL >= bestPenalty) break;
    const da = sA[p]! - query.a;
    const db = sB[p]! - query.b;
    const dist2 = dL * dL + da * da + db * db;
    const k = oi[p]!;
    const hd = hueDistance(hT, pal.entries[k]!.hue);
    const penalty = dist2 + lambda * cT * hd * hd;
    if (penalty < bestPenalty || (penalty === bestPenalty && k < bestIdx)) {
      bestPenalty = penalty;
      bestIdx = k;
      bestDist2 = dist2;
    }
  }
  for (let p = start - 1; p >= 0; p--) {
    const dL = query.L - sL[p]!;
    if (dL * dL >= bestPenalty) break;
    const da = sA[p]! - query.a;
    const db = sB[p]! - query.b;
    const dist2 = dL * dL + da * da + db * db;
    const k = oi[p]!;
    const hd = hueDistance(hT, pal.entries[k]!.hue);
    const penalty = dist2 + lambda * cT * hd * hd;
    if (penalty < bestPenalty || (penalty === bestPenalty && k < bestIdx)) {
      bestPenalty = penalty;
      bestIdx = k;
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
