/**
 * sRGB ↔ linear ↔ OKLab color conversions.
 *
 * OKLab (Björn Ottosson, 2020) is a perceptually-uniform color space: euclidean
 * distance in OKLab approximates perceived color difference far better than raw
 * sRGB or even CIELAB for the saturated, blocky colors in the Minecraft palette.
 * We match in OKLab and diffuse quantization error in *linear* light (so gamma
 * doesn't bias the error distribution).
 */

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Decode one 8-bit sRGB channel (0..255) to linear light (0..1). */
export function srgbChannelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Encode one linear-light channel (0..1) back to 8-bit sRGB (0..255). */
export function linearToSrgbChannel(c: number): number {
  const cl = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const s = cl <= 0.0031308 ? cl * 12.92 : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** Linear-light RGB (each 0..1) → OKLab. */
export function linearRgbToOklab(r: number, g: number, b: number): Lab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** OKLab → linear-light RGB (each 0..1, may be out of gamut). */
export function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** 8-bit sRGB triple (0..255) → OKLab. */
export function srgbToOklab(r8: number, g8: number, b8: number): Lab {
  return linearRgbToOklab(
    srgbChannelToLinear(r8),
    srgbChannelToLinear(g8),
    srgbChannelToLinear(b8),
  );
}
