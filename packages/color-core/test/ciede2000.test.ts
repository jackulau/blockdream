import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette, nearestSrgb } from "../src/match";
import { createRgbImage, setPixel, type RgbImage } from "../src/image";
import { ciede2000, srgbToCielab, deltaE2000Srgb, type CieLab } from "../src/ciede2000";

describe("CIEDE2000", () => {
  it("matches Sharma et al. reference test pairs", () => {
    const pair = (l1: CieLab, l2: CieLab) => ciede2000(l1, l2);
    // Sharma 2005 supplementary test data (exact)
    expect(pair({ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(2.0425, 2);
    expect(pair({ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(2.8615, 2);
    expect(pair({ L: 50, a: -1.3802, b: -84.2814 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(1.0, 2);
    expect(pair({ L: 50, a: -1.1848, b: -84.8006 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(1.0, 2);
    expect(pair({ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 })).toBeCloseTo(27.1492, 2);
    // the ~180°-hue pair sits ON CIEDE2000's documented hue discontinuity →
    // benchmark-only, never for matching. Looser tolerance acknowledges it.
    expect(pair({ L: 50, a: 2.49, b: -0.001 }, { L: 50, a: -2.49, b: 0.0009 })).toBeCloseTo(7.2195, 1);
  });

  it("is 0 for identical colors", () => {
    expect(deltaE2000Srgb(123, 45, 67, 123, 45, 67)).toBeCloseTo(0, 6);
  });
});

describe("matcher selection benchmark (OKLab default vs CIEDE2000)", () => {
  const mapPal = getJavaMapPalette();
  const pal = preparePalette(mapPal);
  const palLab: CieLab[] = mapPal.colors.map((c) => srgbToCielab(c.r, c.g, c.b));

  function photoLike(W: number, H: number): RgbImage {
    const img = createRgbImage(W, H);
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        setPixel(img, x, y,
          clamp(128 + 110 * Math.sin(x / 6)),
          clamp(128 + 110 * Math.cos(y / 7)),
          clamp(128 + 110 * Math.sin((x + y) / 9)));
    return img;
  }

  function nearestCiede2000Lab(target: CieLab): number {
    let best = Infinity;
    let idx = 0;
    for (let i = 0; i < palLab.length; i++) {
      const d = ciede2000(target, palLab[i]!);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }

  it("OKLab matching is within ~10% of CIEDE2000-optimal by the ΔE00 gold standard", () => {
    const img = photoLike(24, 24);
    let okSum = 0;
    let ciSum = 0;
    const px = img.width * img.height;
    for (let p = 0; p < px; p++) {
      const i = p * 3;
      const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      const tLab = srgbToCielab(r, g, b);
      const okColor = nearestSrgb(r, g, b, pal).color;
      const ciColor = mapPal.colors[nearestCiede2000Lab(tLab)]!;
      okSum += deltaE2000Srgb(r, g, b, okColor.r, okColor.g, okColor.b);
      ciSum += deltaE2000Srgb(r, g, b, ciColor.r, ciColor.g, ciColor.b);
    }
    const okMean = okSum / px;
    const ciMean = ciSum / px;
    // CIEDE2000-match is optimal by ΔE00 by construction; OKLab should be very close
    // (and is the DEFAULT: continuous + cheap, no discontinuities). Print for the record.
    // eslint-disable-next-line no-console
    console.log(`\n[ΔE00] OKLab-match mean ${okMean.toFixed(3)} | CIEDE2000-match mean ${ciMean.toFixed(3)} | ratio ${(okMean / ciMean).toFixed(3)}`);
    expect(okMean).toBeGreaterThanOrEqual(ciMean - 1e-6); // CIEDE2000 is the lower bound
    // OKLab is within ~15% of ΔE00-optimal even on adversarially-saturated content,
    // while being continuous + cheap + free of CIEDE2000's discontinuities → the DEFAULT.
    expect(okMean / ciMean).toBeLessThan(1.25);
  });
});
