import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette } from "../src/match";
import { quantizeVideo } from "../src/temporal";
import { createRgbImage, setPixel, type RgbImage } from "../src/image";

const pal = preparePalette(getJavaMapPalette());

function noise(seed: number, w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) % 256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, rnd(), rnd(), rnd());
  return img;
}

describe("temporal coherence", () => {
  it("identical frames produce identical quantization (no flicker)", () => {
    const f = noise(1, 16, 16);
    const out = quantizeVideo([f, f], pal, { method: "none", temporalThreshold: 0.002 });
    expect([...out[1]!.mapColorId]).toEqual([...out[0]!.mapColorId]);
  });

  it("hysteresis reduces per-pixel changes vs no hysteresis on a tiny perturbation", () => {
    const a = noise(7, 24, 24);
    // b = a nudged by ±1 on a few pixels (sub-threshold jitter)
    const b = { ...a, data: Uint8Array.from(a.data) };
    for (let i = 0; i < b.data.length; i += 7) b.data[i] = Math.min(255, b.data[i]! + 1);

    const stable = quantizeVideo([a, b], pal, { method: "none", temporalThreshold: 0.003 });
    const jittery = quantizeVideo([a, b], pal, { method: "none", temporalThreshold: 0 });

    const changes = (q0: Uint8Array, q1: Uint8Array) => {
      let c = 0;
      for (let i = 0; i < q0.length; i++) if (q0[i] !== q1[i]) c++;
      return c;
    };
    const stableChanges = changes(stable[0]!.mapColorId, stable[1]!.mapColorId);
    const jitteryChanges = changes(jittery[0]!.mapColorId, jittery[1]!.mapColorId);
    expect(stableChanges).toBeLessThanOrEqual(jitteryChanges);
  });
});
