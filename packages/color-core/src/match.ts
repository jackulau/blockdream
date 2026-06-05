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
