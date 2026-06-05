import { describe, it, expect } from "vitest";
import {
  srgbToOklab,
  oklabToLinearRgb,
  linearRgbToOklab,
  srgbChannelToLinear,
  linearToSrgbChannel,
} from "../src/oklab";

describe("oklab", () => {
  it("maps sRGB white to OKLab (L≈1, a≈0, b≈0)", () => {
    const w = srgbToOklab(255, 255, 255);
    expect(w.L).toBeCloseTo(1, 3);
    expect(w.a).toBeCloseTo(0, 3);
    expect(w.b).toBeCloseTo(0, 3);
  });

  it("maps sRGB black to OKLab origin", () => {
    const k = srgbToOklab(0, 0, 0);
    expect(k.L).toBeCloseTo(0, 6);
    expect(k.a).toBeCloseTo(0, 6);
    expect(k.b).toBeCloseTo(0, 6);
  });

  it("matches Ottosson reference for pure red", () => {
    // Reference OKLab for sRGB(255,0,0): ~ (0.6279, 0.2249, 0.1258)
    const r = srgbToOklab(255, 0, 0);
    expect(r.L).toBeCloseTo(0.6279, 2);
    expect(r.a).toBeCloseTo(0.2249, 2);
    expect(r.b).toBeCloseTo(0.1258, 2);
  });

  it("round-trips linear RGB through OKLab", () => {
    for (const [r, g, b] of [
      [0.1, 0.5, 0.9],
      [0.8, 0.2, 0.3],
      [0.05, 0.05, 0.05],
    ] as const) {
      const lab = linearRgbToOklab(r, g, b);
      const [r2, g2, b2] = oklabToLinearRgb(lab.L, lab.a, lab.b);
      expect(r2).toBeCloseTo(r, 6);
      expect(g2).toBeCloseTo(g, 6);
      expect(b2).toBeCloseTo(b, 6);
    }
  });

  it("round-trips sRGB gamma encode/decode", () => {
    for (const c of [0, 7, 64, 128, 200, 255]) {
      expect(linearToSrgbChannel(srgbChannelToLinear(c))).toBe(c);
    }
  });
});
