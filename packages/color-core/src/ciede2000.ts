/**
 * CIEDE2000 — the gold-standard perceptual color-difference metric.
 *
 * Per the research (docs/color-theory.md) it is NOT used in the matching loop
 * (it's calibrated only for SMALL differences and has mathematical
 * discontinuities), but it is the right metric to BENCHMARK a matcher against.
 * Implementation follows Sharma, Wu, Dalal (2005).
 */

import { srgbChannelToLinear } from "./oklab";

export interface CieLab {
  L: number;
  a: number;
  b: number;
}

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;
const EPS = 216 / 24389;
const KAP = 24389 / 27;

/** 8-bit sRGB → CIELAB (D65). */
export function srgbToCielab(r8: number, g8: number, b8: number): CieLab {
  const r = srgbChannelToLinear(r8);
  const g = srgbChannelToLinear(g8);
  const b = srgbChannelToLinear(b8);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / Xn;
  const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / Yn;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / Zn;
  const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAP * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/** CIEDE2000 ΔE between two CIELAB colors (kL=kC=kH=1). */
export function ciede2000(c1: CieLab, c2: CieLab): number {
  const { L: L1, a: a1, b: b1 } = c1;
  const { L: L2, a: a2, b: b2 } = c2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = a1p === 0 && b1 === 0 ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = a2p === 0 && b2 === 0 ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);

  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let Hbarp: number;
  if (C1p * C2p === 0) Hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) Hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) Hbarp = (h1p + h2p + 360) / 2;
  else Hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(rad(Hbarp - 30)) +
    0.24 * Math.cos(rad(2 * Hbarp)) +
    0.32 * Math.cos(rad(3 * Hbarp + 6)) -
    0.2 * Math.cos(rad(4 * Hbarp - 63));

  const dTheta = 30 * Math.exp(-(((Hbarp - 275) / 25) ** 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;

  return Math.sqrt(
    (dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH),
  );
}

/** ΔE00 directly between two 8-bit sRGB colors. */
export function deltaE2000Srgb(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return ciede2000(srgbToCielab(r1, g1, b1), srgbToCielab(r2, g2, b2));
}
