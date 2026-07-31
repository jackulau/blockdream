import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  argbInt,
  generateRgbScreenDatapack,
  generateRgbScreenDatapackReference,
  pixelUuid,
  referenceRgbScreenDeltaLines,
  rgbScreenDeltaLines,
  uuidString,
  type RgbScreenFrame,
  type RgbScreenOptions,
} from "../src/rgbscreen";
import type { GeneratedPack } from "../src/datapack";

// Deterministic LCG so the per-frame delta pattern is irregular but reproducible:
// each frame mutates a pseudo-random subset of pixels (some frames touch few pixels,
// some many; runs and singletons interleave), which is the shape real video deltas have.
function makeClip(W: number, H: number, frameCount: number, churn: number): RgbScreenFrame[] {
  let s = 0xbadc0de;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rndByte = () => (rnd() * 256) | 0;
  const n = W * H;
  const frames: RgbScreenFrame[] = [];
  let cur = new Int32Array(n);
  for (let i = 0; i < n; i++) cur[i] = argbInt(rndByte(), rndByte(), rndByte());
  frames.push({ width: W, height: H, argb: cur });
  for (let f = 1; f < frameCount; f++) {
    const next = new Int32Array(cur);
    // per-frame churn wobbles so delta sizes are uneven across frames
    const p = churn * (0.25 + 1.5 * rnd());
    for (let i = 0; i < n; i++) {
      if (rnd() < p) next[i] = argbInt(rndByte(), rndByte(), rndByte());
    }
    frames.push({ width: W, height: H, argb: next });
    cur = next;
  }
  return frames;
}

/** Canonical full-pack serialization: every emitted file, path-sorted, joined. */
function serializePack(pack: GeneratedPack): string {
  return [...pack.files.keys()]
    .sort()
    .map((k) => `=== ${k} ===\n${pack.files.get(k)!}`)
    .join("");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

describe("generateRgbScreenDatapack (precomputed-prefix optimization)", () => {
  const cases: Array<[string, RgbScreenFrame[], RgbScreenOptions]> = [
    ["multi-frame irregular deltas, defaults", makeClip(48, 36, 24, 0.3), {}],
    [
      "kitchen sink: north-facing, SNBT text era, split frames, music, autoplay, negative origin",
      makeClip(32, 24, 16, 0.5),
      {
        namespace: "perfcase",
        facing: "north",
        dataVersion: 4903,
        maxCommandsPerFunction: 100, // forces frames AND screen into part files
        autoplay: true,
        speedTicks: 3,
        origin: { x: -7, y: 80, z: -3 },
        pxScale: { x: 6.5, y: 3.75 },
        packFormat: 61,
        supportedFormats: { min_inclusive: 48, max_inclusive: 61 },
        music: [
          { tick: 0, note: 12, instrument: "harp", velocity: 1 },
          { tick: 4, note: 15, instrument: "bass", velocity: 0.8 },
        ],
      },
    ],
    ["single frame (no deltas at all)", makeClip(16, 16, 1, 0), {}],
  ];

  for (const [name, frames, opts] of cases) {
    it(`is byte-identical to the reference: ${name}`, () => {
      const opt = generateRgbScreenDatapack(frames, opts);
      const ref = generateRgbScreenDatapackReference(frames, opts);
      expect([...opt.files.keys()].sort()).toEqual([...ref.files.keys()].sort());
      const optAll = serializePack(opt);
      const refAll = serializePack(ref);
      expect(sha256(optAll)).toBe(sha256(refAll));
      expect(optAll).toBe(refAll); // full emitted output, every file, joined
      expect(opt.totalCommands).toBe(ref.totalCommands);
      expect(opt.totalSetblocks).toBe(ref.totalSetblocks);
      expect(opt.frameCount).toBe(ref.frameCount);
    });
  }

  // The direct-body-build path (goal 087): a frame whose delta fits the per-function limit has
  // its body string built directly, skipping the line array + join; an over-limit frame falls
  // back to the array + writeSplitFunction path. This clip pins the BOUNDARY deterministically:
  // frame 1's delta is EXACTLY the limit (must stay a single file), frame 2's is limit+1 (must
  // split into parts), and the wrap delta (frame 0) is over the limit too.
  it("split boundary: a frame at exactly the limit stays single, one past it splits, all byte-identical", () => {
    const W = 20, H = 10, n = W * H;
    const limit = 50;
    const A = argbInt(10, 20, 30), B = argbInt(200, 100, 50), C = argbInt(5, 250, 125);
    const f0 = new Int32Array(n).fill(A);
    const f1 = new Int32Array(f0);
    for (let i = 0; i < limit; i++) f1[i] = B; // delta exactly == limit
    const f2 = new Int32Array(f1);
    for (let i = 100; i <= 100 + limit; i++) f2[i] = C; // delta == limit+1
    const frames: RgbScreenFrame[] = [f0, f1, f2].map((argb) => ({ width: W, height: H, argb }));
    const opts: RgbScreenOptions = { maxCommandsPerFunction: limit };
    const opt = generateRgbScreenDatapack(frames, opts);
    const ref = generateRgbScreenDatapackReference(frames, opts);
    const fnDir = `data/${opt.namespace}/function`;
    expect(opt.files.has(`${fnDir}/frames/1.mcfunction`)).toBe(true);
    expect(opt.files.has(`${fnDir}/frames/1/part0.mcfunction`)).toBe(false); // == limit: single file
    expect(opt.files.has(`${fnDir}/frames/2/part0.mcfunction`)).toBe(true); // limit+1: split
    expect(opt.files.has(`${fnDir}/frames/2/part1.mcfunction`)).toBe(true);
    expect(opt.files.has(`${fnDir}/frames/0/part0.mcfunction`)).toBe(true); // wrap delta (101) splits
    expect(serializePack(opt)).toBe(serializePack(ref));
    expect(opt.totalCommands).toBe(ref.totalCommands);
  });

  // Same-run interleaved A/B on the CHANGED loop (same style as bench-smoke.test.ts
  // runAB, which times each optimized loop against its reference): both delta-line
  // builders run back-to-back in this process over the same frames. Timing the whole
  // pack emit instead would gate on the shared join/Map/GC floor, which measurement
  // showed is dominated by garbage-collection landing spots, not by the changed code.
  // retry: a timing inversion needs a sustained hostile phase (loaded box, E-core
  // scheduling, starved JIT threads) across EVERY attempt to produce a false failure,
  // while a genuine regression loses all attempts in any environment.
  it("delta-line hot loop is byte-identical to the reference AND faster (same-run interleaved timing)", { retry: 2, timeout: 60000 }, () => {
    const frames = makeClip(64, 48, 96, 0.4); // 3072 px, 96 frames, irregular churn
    const n = 64 * 48;
    const ns = "blockdream_rgb";
    const uuids: string[] = new Array(n);
    const prefixes: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      uuids[i] = uuidString(pixelUuid(ns, i));
      prefixes[i] = `data merge entity ${uuids[i]} {background:`;
    }
    const pairs: Array<[Int32Array, Int32Array]> = frames.map((fr, f) => [
      fr.argb,
      frames[(f - 1 + frames.length) % frames.length]!.argb,
    ]);
    const runRef = () => {
      let total = 0;
      for (const [cur, prev] of pairs) total += referenceRgbScreenDeltaLines(cur, prev, uuids).length;
      return total;
    };
    const runOpt = () => {
      let total = 0;
      for (const [cur, prev] of pairs) total += rgbScreenDeltaLines(cur, prev, prefixes).length;
      return total;
    };
    // byte identity of every emitted line, and warmup for the JIT
    for (const [cur, prev] of pairs) {
      expect(rgbScreenDeltaLines(cur, prev, prefixes)).toEqual(referenceRgbScreenDeltaLines(cur, prev, uuids));
    }
    expect(runOpt()).toBeGreaterThan(0); // non-trivial workload, not an empty-delta fluke
    expect(runOpt()).toBe(runRef());
    // 12 interleaved rounds with the ref/opt ORDER alternating each round: whoever runs
    // second inherits the first's GC debt, so a fixed order systematically biases the
    // comparison; alternation cancels that. Compare MEDIANS: a major GC or an OS
    // scheduling spike lands in one arbitrary round (observed: a 30x outlier round on a
    // loaded box), which poisons a sum and can even poison a min, while the median
    // ignores it on either side.
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    for (let iter = 0; iter < 12; iter++) {
      if (iter % 2 === 0) {
        refTimes.push(timed(runRef));
        optTimes.push(timed(runOpt));
      } else {
        optTimes.push(timed(runOpt));
        refTimes.push(timed(runRef));
      }
    }
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // the optimization changes nothing but speed; measured ~1.3-2x locally, assert only
    // strictly-faster so a busy CI box cannot flake the gate
    expect(optMs).toBeLessThan(refMs);
  });

  // Goal 087 D12: whole-pack A/B. The delta-line hot-loop test above is the PERF GATE for
  // this optimization; whole-pack timing stays a no-regression check only. Even with each
  // timed sample batching 3 whole packs to amortize GC (a single pack's time is bimodal -
  // a major GC either lands in it or not - measured 0.4x-2.4x single-pack swing), the
  // end-to-end ratio still dipped to 0.94x-1.21x under a saturated box while the hot loop
  // held its speedup: whole-pack time is dominated by a shared uuid/prefix/summon/GC floor
  // that timing cannot attribute fairly (same lesson as the goal 086 GIF encoder gate).
  // So: byte-identity always, and a 0.8x floor that only catches a real regression.
  it("whole-pack generation is byte-identical to the reference AND not slower (same-run interleaved batched medians, no-regression floor)", { retry: 2, timeout: 120000 }, () => {
    const frames = makeClip(64, 48, 96, 0.4); // bench-default workload: 3072 px, 96 frames
    // byte identity of the full emitted pack (also JIT warmup for both paths)
    const opt0 = generateRgbScreenDatapack(frames);
    const ref0 = generateRgbScreenDatapackReference(frames);
    expect(serializePack(opt0)).toBe(serializePack(ref0));
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const optBatch = () => {
      for (let k = 0; k < 3; k++) generateRgbScreenDatapack(frames);
    };
    const refBatch = () => {
      for (let k = 0; k < 3; k++) generateRgbScreenDatapackReference(frames);
    };
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    for (let iter = 0; iter < 8; iter++) {
      if (iter % 2 === 0) {
        refTimes.push(timed(refBatch));
        optTimes.push(timed(optBatch));
      } else {
        optTimes.push(timed(optBatch));
        refTimes.push(timed(refBatch));
      }
    }
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs / optMs).toBeGreaterThanOrEqual(0.8);
  });
});
