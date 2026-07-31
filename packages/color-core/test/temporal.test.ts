import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, buildRgbLut } from "../src/match";
import { quantizeVideo } from "../src/temporal";
import { quantizeFrame, type QuantizeOptions } from "../src/dither";
import { createRgbImage, setPixel, type RgbImage, type QuantizedFrame } from "../src/image";
import { srgbToOklab } from "../src/oklab";

const pal = preparePalette(getJavaMapPalette());
const lut = buildRgbLut(pal, 33);

function noise(seed: number, w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) % 256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, rnd(), rnd(), rnd());
  return img;
}

// Smooth gradient: long runs of near-identical colors, the shape where ordered dithering
// actually changes picks (and where bayer-vs-none must differ).
function gradient(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = w > 1 ? Math.round((x / (w - 1)) * 255) : 128;
      const g = h > 1 ? Math.round((y / (h - 1)) * 255) : 128;
      const b = Math.round(((x + y) % 32) * 4);
      setPixel(img, x, y, r, g, b);
    }
  return img;
}

// Saturated out-of-gamut colors: where the hue-penalized gamut map picks different blocks
// than the plain nearest match.
function saturated(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const phase = (x + y * w) % 4;
      if (phase === 0) setPixel(img, x, y, 255, 0, 255);
      else if (phase === 1) setPixel(img, x, y, 0, 255, Math.min(255, x * 8));
      else if (phase === 2) setPixel(img, x, y, 255, Math.min(160, y * 6), 0);
      else setPixel(img, x, y, Math.min(255, 40 + x * 5), 0, 255);
    }
  return img;
}

function expectElementIdentical(a: QuantizedFrame, b: QuantizedFrame): void {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let mismatches = 0;
  for (let i = 0; i < a.paletteIndex.length; i++) {
    if (a.paletteIndex[i] !== b.paletteIndex[i] || a.mapColorId[i] !== b.mapColorId[i]) mismatches++;
  }
  expect(mismatches).toBe(0);
}

function countDiffs(a: Uint8Array, b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c++;
  return c;
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

    const stableChanges = countDiffs(stable[0]!.mapColorId, stable[1]!.mapColorId);
    const jitteryChanges = countDiffs(jittery[0]!.mapColorId, jittery[1]!.mapColorId);
    expect(stableChanges).toBeLessThanOrEqual(jitteryChanges);
  });
});

describe("temporal candidate parity with the non-temporal quantizer (D4)", () => {
  // A frame with NO previous frame must quantize ELEMENT-IDENTICAL to quantizeFrame: the
  // hysteresis loop's candidate is required to be exactly the non-temporal match (bayer offset
  // applied, gamutMap honoured, LUT honoured, gamutMap overriding the LUT).
  const mixed = (() => {
    // saturated + noise + gradient bands in one image so every dispatch path has real work
    const img = createRgbImage(24, 24);
    const s = saturated(24, 8);
    const n = noise(42, 24, 8);
    const g = gradient(24, 8);
    img.data.set(s.data, 0);
    img.data.set(n.data, 24 * 8 * 3);
    img.data.set(g.data, 24 * 16 * 3);
    return img;
  })();

  const configs: Array<[string, QuantizeOptions]> = [
    ["bayer plain", { method: "bayer" }],
    ["bayer + gamutMap", { method: "bayer", gamutMap: 0.8 }],
    ["bayer + lut", { method: "bayer", lut }],
    ["bayer + lut + gamutMap (gamut overrides lut)", { method: "bayer", lut, gamutMap: 0.8 }],
    ["bayer amplitude 0.035", { method: "bayer", bayerAmplitude: 0.035 }],
    ["nearest plain", { method: "none" }],
    ["nearest + gamutMap", { method: "none", gamutMap: 0.8 }],
    ["nearest + lut", { method: "none", lut }],
    ["nearest + lut + gamutMap (gamut overrides lut)", { method: "none", lut, gamutMap: 0.8 }],
  ];

  for (const [name, cfg] of configs) {
    it(`first frame is element-identical to quantizeFrame: ${name}`, () => {
      const still = quantizeFrame(mixed, pal, cfg);
      const video = quantizeVideo([mixed], pal, { ...cfg, temporalThreshold: 0.002 });
      expectElementIdentical(video[0]!, still);
    });
  }

  it("later frames: every pixel is either the still-quantize pick or a retained previous index", () => {
    const a = saturated(24, 24);
    const b = { ...a, data: Uint8Array.from(a.data) };
    for (let i = 0; i < b.data.length; i += 5) b.data[i] = Math.max(0, b.data[i]! - 2);
    const cfg: QuantizeOptions = { method: "bayer", gamutMap: 0.8 };
    const video = quantizeVideo([a, b], pal, { ...cfg, temporalThreshold: 0.002 });
    const still = quantizeFrame(b, pal, cfg);
    for (let p = 0; p < still.paletteIndex.length; p++) {
      const got = video[1]!.paletteIndex[p]!;
      expect(got === still.paletteIndex[p] || got === video[0]!.paletteIndex[p]).toBe(true);
    }
  });

  it("gamutMap changes temporal output (it was silently dropped before)", () => {
    const f = saturated(16, 16);
    const plain = quantizeVideo([f, f], pal, { method: "bayer", temporalThreshold: 0.002 });
    const gamut = quantizeVideo([f, f], pal, { method: "bayer", temporalThreshold: 0.002, gamutMap: 0.8 });
    expect(countDiffs(plain[1]!.mapColorId, gamut[1]!.mapColorId)).toBeGreaterThan(0);
  });

  it("bayer differs from none under temporal (the offset was silently dropped before)", () => {
    const f = gradient(32, 32);
    const bayer = quantizeVideo([f], pal, { method: "bayer", temporalThreshold: 0.002 });
    const none = quantizeVideo([f], pal, { method: "none", temporalThreshold: 0.002 });
    expect(countDiffs(bayer[0]!.mapColorId, none[0]!.mapColorId)).toBeGreaterThan(0);
  });

  it("hysteresis retention: a pixel crossing a palette boundary within threshold keeps its index", () => {
    // Search for a gray step (g, g+1) whose plain-nearest picks DIFFER but whose OKLab
    // distances are within the threshold: the non-temporal quantizer flips, hysteresis holds.
    const threshold = 0.003;
    let found: { v0: number; v1: number } | null = null;
    for (let v = 0; v < 255 && !found; v++) {
      const i0 = quantizeFrame(gray1x1(v), pal, { method: "none" }).paletteIndex[0]!;
      const i1 = quantizeFrame(gray1x1(v + 1), pal, { method: "none" }).paletteIndex[0]!;
      if (i0 === i1) continue;
      const target = srgbToOklab(v + 1, v + 1, v + 1);
      const keep = dist2ToEntry(target, i0);
      const best = dist2ToEntry(target, i1);
      if (keep <= best + threshold) found = { v0: v, v1: v + 1 };
    }
    expect(found).not.toBeNull();
    const video = quantizeVideo([gray1x1(found!.v0), gray1x1(found!.v1)], pal, {
      method: "none",
      temporalThreshold: threshold,
    });
    const still = quantizeFrame(gray1x1(found!.v1), pal, { method: "none" });
    expect(still.paletteIndex[0]).not.toBe(video[0]!.paletteIndex[0]);
    // retained: frame 1 keeps frame 0's index even though the still pick flipped
    expect(video[1]!.paletteIndex[0]).toBe(video[0]!.paletteIndex[0]);

    function gray1x1(v: number): RgbImage {
      const img = createRgbImage(1, 1);
      setPixel(img, 0, 0, v, v, v);
      return img;
    }
    function dist2ToEntry(t: { L: number; a: number; b: number }, idx: number): number {
      const e = pal.entries[idx]!.lab;
      const dL = t.L - e.L;
      const da = t.a - e.a;
      const db = t.b - e.b;
      return dL * dL + da * da + db * db;
    }
  });

  it("floyd-steinberg branch is untouched by temporalThreshold (per-frame quantizeFrame)", () => {
    const f = noise(9, 16, 16);
    const video = quantizeVideo([f, f], pal, { method: "floyd-steinberg", temporalThreshold: 0.002 });
    const still = quantizeFrame(f, pal, { method: "floyd-steinberg" });
    expectElementIdentical(video[0]!, still);
    expectElementIdentical(video[1]!, still);
  });
});
