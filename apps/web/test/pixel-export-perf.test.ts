// Perf regression net for the optimized pixel-export hot paths: the GIF encoder (typed-array LZW
// dictionary + open-addressing colour hash) and the per-frame raster helpers (flat Uint8Array
// palette tables in quantizedToRaster / flatVolumeToRaster, row-replicating copyWithin in
// upscaleNearest). Every optimized function must stay BYTE-IDENTICAL to its retained reference
// (the original algorithm kept verbatim in the module), and be faster - A/B'd in the SAME
// process, back-to-back, so machine noise hits both sides equally (same discipline as
// packages/voxel/test/bench-smoke.test.ts).

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { QuantizedFrame } from "@blockdream/color-core";
import { createVolume, EMPTY } from "@blockdream/voxel";
import {
  encodeGif,
  encodeGifReference,
  quantizedToRaster,
  quantizedToRasterReference,
  flatVolumeToRaster,
  flatVolumeToRasterReference,
  upscaleNearest,
  upscaleNearestReference,
  type GifFrame,
  type Raster,
} from "../src/pixel-export";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Tiny solid-colour raster helper for the dimension-guard test. */
function solid(width: number, height: number, rgb: [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    data.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
  }
  return { width, height, data };
}

/**
 * Deterministic non-trivial clip: several frames of varied content over 220 distinct colours
 * (all distinct in the red channel), mixing per-row runs (block-art-like, feeds the LZW dictionary
 * and the last-colour memo), pure noise (forces dictionary misses and code-width growth up to the
 * clear-code path), and ~8% transparent pixels (exercises the reserved transparent index).
 */
function perfClip(frameCount: number, width: number, height: number): GifFrame[] {
  let seed = 0x0badf00d;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const colors: Array<[number, number, number]> = [];
  for (let i = 0; i < 220; i++) colors.push([i, (i * i + 7) & 0xff, 255 - i]);

  const frames: GifFrame[] = [];
  for (let f = 0; f < frameCount; f++) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const roll = rand() % 100;
      if (roll < 8) continue; // transparent pixel (alpha stays 0)
      const c = roll < 70 ? colors[(((p / width) | 0) + f * 3) % 220]! : colors[rand() % 220]!;
      const o = p * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
    frames.push({ raster: { width, height, data }, delayMs: 40 + f * 10 });
  }
  return frames;
}

describe("pixel-export optimized GIF encoder vs retained reference", () => {
  it("encodeGif output is byte-identical to the reference (SHA-256 compared) on a 220-colour multi-frame clip", () => {
    const frames = perfClip(6, 128, 128);
    const opt = encodeGif(frames);
    const ref = encodeGifReference(frames);

    const hashOpt = sha256(opt);
    const hashRef = sha256(ref);
    expect(opt.length, "optimized and reference byte lengths").toBe(ref.length);
    expect(hashOpt, `optimized sha256 ${hashOpt} must equal reference sha256 ${hashRef}`).toBe(hashRef);
    expect(
      Buffer.compare(
        Buffer.from(opt.buffer, opt.byteOffset, opt.length),
        Buffer.from(ref.buffer, ref.byteOffset, ref.length),
      ),
      `byte-for-byte comparison (sha256 ${hashOpt})`,
    ).toBe(0);
    console.log(`encodeGif byte-identical: sha256 ${hashOpt} (${opt.length} bytes, ${frames.length} frames)`);

    // odd, non-square dimensions hit the partial-byte / sub-block flush edges differently
    const odd = perfClip(3, 61, 37);
    expect(sha256(encodeGif(odd)), "odd-size clip sha256").toBe(sha256(encodeGifReference(odd)));

    // fully opaque clip: no transparent slot reserved, different palette sizing path
    const opaque: GifFrame[] = [
      { raster: solid(24, 24, [10, 20, 30]), delayMs: 100 },
      { raster: solid(24, 24, [200, 100, 50]), delayMs: 100 },
    ];
    expect(sha256(encodeGif(opaque)), "opaque clip sha256").toBe(sha256(encodeGifReference(opaque)));
  });

  it("optimized encodeGif is faster than the reference (same-run interleaved A/B)", { timeout: 60000, retry: 2 }, () => {
    const frames = perfClip(6, 128, 128);

    // warm both paths up (JIT), then interleave rounds so noise hits both sides equally
    encodeGifReference(frames);
    encodeGif(frames);

    // min-of-rounds per side: a shared dev box shows multi-second scheduler/GC spikes, and the
    // MINIMUM round is the noise-robust estimate of each side's true cost (a spike only ever makes
    // a round slower, never faster)
    let refMs = Infinity;
    let optMs = Infinity;
    for (let round = 0; round < 9; round++) {
      let t = performance.now();
      encodeGifReference(frames);
      refMs = Math.min(refMs, performance.now() - t);
      t = performance.now();
      encodeGif(frames);
      optMs = Math.min(optMs, performance.now() - t);
    }

    const speedup = refMs / optMs;
    console.log(`encodeGif A/B (min of 9 rounds): reference ${refMs.toFixed(1)} ms, optimized ${optMs.toFixed(1)} ms, speedup ${speedup.toFixed(2)}x`);
    expect(Number.isFinite(speedup), "speedup is finite").toBe(true);
    // generous margin well below the locally measured speedup, guarding regression without CI flake
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.15);
  });

  it("throws loudly when a later frame's dimensions do not match frame 0 (was silent corruption)", () => {
    const good: GifFrame = { raster: solid(4, 4, [200, 30, 30]), delayMs: 50 };
    const badWidth: GifFrame = { raster: solid(3, 4, [20, 190, 60]), delayMs: 50 };
    const badHeight: GifFrame = { raster: solid(4, 5, [20, 190, 60]), delayMs: 50 };

    expect(() => encodeGif([good, badWidth])).toThrow(/frame 1 is 3x4 but frame 0 is 4x4/);
    expect(() => encodeGif([good, good, badHeight])).toThrow(/frame 2 is 4x5 but frame 0 is 4x4/);

    // matching frames still encode fine (the guard is purely additive)
    expect(() => encodeGif([good, good])).not.toThrow();
  });
});

// ---- raster helpers: flat palette tables + copyWithin row replication --------------------------

/** Deterministic LCG so every fixture is irregular but reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/**
 * Export-shaped quantized frame: ~35% air (mapColorId 0, the common MISS that made the reference
 * allocate a fallback tuple per pixel), the rest spread over the whole 0..255 id space so both
 * mapped and unmapped ids are exercised.
 */
function randomQuantized(width: number, height: number, seed: number): QuantizedFrame {
  const rand = lcg(seed);
  const mapColorId = new Uint8Array(width * height);
  for (let p = 0; p < mapColorId.length; p++) {
    const roll = rand() % 100;
    mapColorId[p] = roll < 35 ? 0 : rand() % 256;
  }
  return { width, height, mapColorId, paletteIndex: new Int32Array(width * height) };
}

/** Random flat-ish volume: ~30% all-air columns, voxels at varying depths, ids over 0..254. */
function randomFlatVolume(sx: number, sy: number, sz: number, seed: number) {
  const v = createVolume(sx, sy, sz);
  const rand = lcg(seed);
  for (let i = 0; i < v.data.length; i++) {
    const roll = rand() % 100;
    if (roll < 45) continue; // stays EMPTY
    v.data[i] = rand() % 255; // 0..254, never the EMPTY sentinel
  }
  expect(v.data.some((c) => c === EMPTY)).toBe(true);
  return v;
}

/** Random RGBA raster with ~10% transparent pixels (alpha must replicate exactly too). */
function randomRaster(width: number, height: number, seed: number): Raster {
  const rand = lcg(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = rand() % 256;
    data[o + 1] = rand() % 256;
    data[o + 2] = rand() % 256;
    data[o + 3] = rand() % 100 < 10 ? rand() % 128 : 255;
  }
  return { width, height, data };
}

function expectRasterIdentical(opt: Raster, ref: Raster, label: string): void {
  expect(opt.width, `${label}: width`).toBe(ref.width);
  expect(opt.height, `${label}: height`).toBe(ref.height);
  expect(opt.data.length, `${label}: byte length`).toBe(ref.data.length);
  expect(
    Buffer.compare(
      Buffer.from(opt.data.buffer, opt.data.byteOffset, opt.data.byteLength),
      Buffer.from(ref.data.buffer, ref.data.byteOffset, ref.data.byteLength),
    ),
    `${label}: bytes`,
  ).toBe(0);
}

/** Min-of-rounds interleaved A/B (a spike only ever makes a round slower, never faster). */
function abMinOfRounds(runRef: () => unknown, runOpt: () => unknown, rounds: number): { refMs: number; optMs: number } {
  runRef();
  runOpt(); // JIT warmup for both sides
  let refMs = Infinity;
  let optMs = Infinity;
  for (let round = 0; round < rounds; round++) {
    let t = performance.now();
    runRef();
    refMs = Math.min(refMs, performance.now() - t);
    t = performance.now();
    runOpt();
    optMs = Math.min(optMs, performance.now() - t);
  }
  return { refMs, optMs };
}

describe("pixel-export raster helpers vs retained references", () => {
  it("quantizedToRaster is byte-identical to the reference (air-heavy, full id spread, odd sizes)", () => {
    for (const [w, h, seed] of [
      [128, 128, 0xa11ce],
      [61, 37, 0xbee],
      [1, 1, 0xc0de],
      [256, 144, 0xd00d],
    ] as const) {
      const q = randomQuantized(w, h, seed);
      expectRasterIdentical(quantizedToRaster(q), quantizedToRasterReference(q), `quantized ${w}x${h}`);
    }
  });

  it("flatVolumeToRaster is byte-identical to the reference (air columns, depth occlusion, id spread)", () => {
    for (const [sx, sy, sz, seed] of [
      [128, 96, 1, 0x1234],
      [64, 64, 4, 0x5678],
      [3, 5, 2, 0x9abc],
    ] as const) {
      const v = randomFlatVolume(sx, sy, sz, seed);
      expectRasterIdentical(flatVolumeToRaster(v), flatVolumeToRasterReference(v), `volume ${sx}x${sy}x${sz}`);
    }
  });

  it("upscaleNearest is byte-identical to the reference (scales 2,3,4,7, non-integer, s=1 same-object)", () => {
    for (const [w, h, scale, seed] of [
      [128, 96, 4, 0x111],
      [61, 37, 3, 0x222],
      [16, 16, 7, 0x333],
      [50, 20, 2.9, 0x444], // floors to 2
    ] as const) {
      const src = randomRaster(w, h, seed);
      expectRasterIdentical(upscaleNearest(src, scale), upscaleNearestReference(src, scale), `upscale ${w}x${h} x${scale}`);
    }
    const src = randomRaster(4, 4, 0x555);
    expect(upscaleNearest(src, 1), "s=1 returns the source object").toBe(src);
    expect(upscaleNearestReference(src, 1)).toBe(src);
  });

  it("optimized quantizedToRaster is faster than the reference (same-run interleaved A/B)", { timeout: 60000, retry: 2 }, () => {
    // the whole-video export path calls this once per clip frame; batch 24 frames per round so a
    // round is long enough to time reliably
    const frames: QuantizedFrame[] = [];
    for (let f = 0; f < 24; f++) frames.push(randomQuantized(256, 144, 0xf00 + f));
    const { refMs, optMs } = abMinOfRounds(
      () => frames.forEach((q) => quantizedToRasterReference(q)),
      () => frames.forEach((q) => quantizedToRaster(q)),
      9,
    );
    const speedup = refMs / optMs;
    console.log(
      `quantizedToRaster A/B (min of 9 rounds, 24x 256x144 frames): reference ${refMs.toFixed(2)} ms, ` +
        `optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(2)}x`,
    );
    // generous margin well below the locally measured speedup, guarding regression without CI flake
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.1);
  });

  it("optimized upscaleNearest is faster than the reference (same-run interleaved A/B)", { timeout: 60000, retry: 2 }, () => {
    // fitScale targets 384-512px: a 128x96 block grid ships at x4 = 512x384
    const sources: Raster[] = [];
    for (let f = 0; f < 12; f++) sources.push(randomRaster(128, 96, 0xabc + f));
    const { refMs, optMs } = abMinOfRounds(
      () => sources.forEach((r) => upscaleNearestReference(r, 4)),
      () => sources.forEach((r) => upscaleNearest(r, 4)),
      9,
    );
    const speedup = refMs / optMs;
    console.log(
      `upscaleNearest A/B (min of 9 rounds, 12x 128x96 -> x4): reference ${refMs.toFixed(2)} ms, ` +
        `optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(2)}x`,
    );
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.2);
  });
});
