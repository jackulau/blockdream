import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, nearestSrgb, nearestByLab, nearestByLabHue, hueDistance } from "../src/match";
import { srgbToOklab, type Lab } from "../src/oklab";

const pal = preparePalette(getJavaMapPalette());

// Index-order brute force = the pre-acceleration reference. The L-band matchers must equal this
// byte-for-byte: same chosen index (lowest index among equal-distance), same dist2.
function bruteLab(q: Lab): { index: number; dist2: number } {
  let bi = 0;
  let best = Infinity;
  for (let i = 0; i < pal.entries.length; i++) {
    const e = pal.entries[i]!.lab;
    const dL = q.L - e.L;
    const da = q.a - e.a;
    const db = q.b - e.b;
    const d = dL * dL + da * da + db * db;
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  return { index: bi, dist2: best };
}
function bruteHue(q: Lab, lambda: number): { index: number; dist2: number } {
  const cT = Math.hypot(q.a, q.b);
  const hT = Math.atan2(q.b, q.a);
  let bi = 0;
  let bestP = Infinity;
  let bestD = Infinity;
  for (let i = 0; i < pal.entries.length; i++) {
    const e = pal.entries[i]!;
    const dL = q.L - e.lab.L;
    const da = q.a - e.lab.a;
    const db = q.b - e.lab.b;
    const dist2 = dL * dL + da * da + db * db;
    const hd = hueDistance(hT, e.hue);
    const pen = dist2 + lambda * cT * hd * hd;
    if (pen < bestP) {
      bestP = pen;
      bi = i;
      bestD = dist2;
    }
  }
  return { index: bi, dist2: bestD };
}

describe("nearest match", () => {
  it("matches an exact palette color to itself", () => {
    // grass base, full shade: mapColorId 6 = (127,178,56)
    const m = nearestSrgb(127, 178, 56, pal);
    expect(m.color.mapColorId).toBe(6);
    expect(m.dist2).toBeCloseTo(0, 9);
  });

  it("matches pure white to the brightest near-white palette entry", () => {
    const m = nearestSrgb(255, 255, 255, pal);
    // closest palette color should itself be very light
    expect(m.color.r + m.color.g + m.color.b).toBeGreaterThan(600);
  });

  it("always returns a valid map color id in [4,247]", () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const m = nearestSrgb(r, g, b, pal);
          expect(m.color.mapColorId).toBeGreaterThanOrEqual(4);
          expect(m.color.mapColorId).toBeLessThanOrEqual(247);
        }
      }
    }
  });
});

describe("L-band exact match (byte-identical to brute force)", () => {
  it("builds a monotone L-sorted structure covering every entry", () => {
    expect(pal.sortedOrigIdx.length).toBe(pal.entries.length);
    expect(pal.sortedLab.length).toBe(pal.entries.length * 3);
    // every original index appears exactly once
    const seen = new Set(pal.sortedOrigIdx);
    expect(seen.size).toBe(pal.entries.length);
    // L is non-decreasing, and each slot's coords match the referenced entry
    for (let p = 1; p < pal.sortedOrigIdx.length; p++) {
      expect(pal.sortedLab[p * 3]!).toBeGreaterThanOrEqual(pal.sortedLab[(p - 1) * 3]!);
    }
    for (let p = 0; p < pal.sortedOrigIdx.length; p++) {
      const e = pal.entries[pal.sortedOrigIdx[p]!]!.lab;
      expect(pal.sortedLab[p * 3]!).toBe(e.L);
      expect(pal.sortedLab[p * 3 + 1]!).toBe(e.a);
      expect(pal.sortedLab[p * 3 + 2]!).toBe(e.b);
    }
  });

  it("nearestByLab == index-order brute force over a dense sRGB grid (index + dist2)", () => {
    let mismatches = 0;
    let tested = 0;
    for (let r = 0; r < 256; r += 4)
      for (let g = 0; g < 256; g += 4)
        for (let b = 0; b < 256; b += 4) {
          const q = srgbToOklab(r, g, b);
          const ref = bruteLab(q);
          const got = nearestByLab(q, pal);
          if (got.index !== ref.index || got.dist2 !== ref.dist2) mismatches++;
          tested++;
        }
    expect(tested).toBeGreaterThan(250000);
    expect(mismatches).toBe(0);
  });

  it("nearestByLabHue == index-order brute force over a dense sRGB grid (default + rigid lambda)", () => {
    for (const lambda of [0.6, 1.2]) {
      let mismatches = 0;
      for (let r = 0; r < 256; r += 5)
        for (let g = 0; g < 256; g += 5)
          for (let b = 0; b < 256; b += 5) {
            const q = srgbToOklab(r, g, b);
            const ref = bruteHue(q, lambda);
            const got = nearestByLabHue(q, pal, lambda);
            if (got.index !== ref.index || got.dist2 !== ref.dist2) mismatches++;
          }
      expect(mismatches).toBe(0);
    }
  });
});
