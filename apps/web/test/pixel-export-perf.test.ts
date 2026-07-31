// Perf regression net for the optimized GIF export hot path (typed-array LZW dictionary +
// open-addressing colour hash). The optimized encodeGif must stay BYTE-IDENTICAL to the retained
// reference (encodeGifReference, the original Map-based algorithm kept verbatim in the module),
// and it must actually be faster - both A/B'd in the SAME process, back-to-back, so machine noise
// hits both sides equally (same discipline as packages/voxel/test/bench-smoke.test.ts).

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { encodeGif, encodeGifReference, type GifFrame, type Raster } from "../src/pixel-export";

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
