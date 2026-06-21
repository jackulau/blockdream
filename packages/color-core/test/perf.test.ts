import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, buildRgbLut, lutNearest, nearestSrgb } from "../src/match";
import { quantizeNearest } from "../src/dither";
import { createRgbImage, type RgbImage } from "../src/image";

const pal = preparePalette(getJavaMapPalette());
const lut = buildRgbLut(pal, 33);

function pseudoRandomImage(W: number, H: number): RgbImage {
  const img = createRgbImage(W, H);
  let s = 12345;
  for (let i = 0; i < img.data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = (s >> 8) & 255;
  }
  return img;
}

describe("LUT matcher (efficiency)", () => {
  it("LUT lookups are near-optimal vs brute force (tiny perceptual penalty)", () => {
    let mism = 0;
    let tot = 0;
    let extra = 0;
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          tot++;
          const bf = nearestSrgb(r, g, b, pal).index;
          const lu = lutNearest(lut, r, g, b);
          if (bf !== lu) {
            mism++;
            const cb = pal.entries[bf]!.color;
            const cl = pal.entries[lu]!.color;
            const dl = Math.hypot(cl.r - r, cl.g - g, cl.b - b);
            const db = Math.hypot(cb.r - r, cb.g - g, cb.b - b);
            extra += Math.max(0, dl - db);
          }
        }
    const meanExtra = extra / Math.max(1, mism);
    // mismatches sit on Voronoi boundaries → the "wrong" pick is nearly as good
    expect(meanExtra).toBeLessThan(12); // RGB units; measured ~6.4 (imperceptible)
    expect(mism / tot).toBeLessThan(0.2);
  });

  it("LUT-quantized frame is identical-or-near to brute and has valid ids", () => {
    const img = pseudoRandomImage(64, 64);
    const fast = quantizeNearest(img, pal, lut);
    const exact = quantizeNearest(img, pal);
    let diff = 0;
    for (let i = 0; i < fast.mapColorId.length; i++) if (fast.mapColorId[i] !== exact.mapColorId[i]) diff++;
    expect(diff / fast.mapColorId.length).toBeLessThan(0.2);
    expect([...fast.mapColorId].every((v) => v >= 4 && v <= 247)).toBe(true);
  });

  it("exact L-band match is fast enough for video on its own (the lossy LUT is no longer needed for speed)", () => {
    const img = pseudoRandomImage(256, 256);
    // Best-of-N timings: the minimum is the least noisy estimate, so this stays robust under
    // a busy machine/CI (absolute throughput is environment-dependent and must not gate CI).
    const best = (run: () => void): number => {
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        run();
        m = Math.min(m, performance.now() - t);
      }
      return m;
    };
    // Before the L-band prune, exact brute force was the video bottleneck and the approximate
    // RgbLut existed to dodge it. The prune makes the EXACT path ~9x faster, so it now clears a
    // real-time floor with ZERO quality loss - locally it even beats the LUT. The LUT remains only
    // a precompute-amortization option (its quality is covered by the two tests above).
    const exact = best(() => quantizeNearest(img, pal));
    const mpx = (256 * 256) / 1e6 / (exact / 1000);
    expect(mpx).toBeGreaterThan(1.5); // conservative for busy CI; locally ~38 Mpx/s
  });
});
