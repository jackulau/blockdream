// Locks the goal-089 D22 hot-loop hoists against their verbatim pre-optimization reference twins:
// - depth.ts imageToSolid: isBackground/depthOf/shadingOf hoisted off the options object (they run
//   per pixel; video3d.ts calls imageToSolid per frame with arrow callbacks). CALLBACK CONTRACT:
//   hoisted calls pass `this` = undefined, not the options object - arrows and BOUND methods are
//   byte-identical to the reference; an unbound this-dependent method is not supported.
// - voxelize.ts imageToVolume: per-invocation 256-slot heightOf memo (called once per DISTINCT
//   byte id instead of once per pixel; heightOf must be deterministic per id within one call).

import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid, imageToSolidReference, type SolidifyImageOptions } from "../src/depth";
import { imageToVolume, imageToVolumeReference, type VoxelizeOptions } from "../src/voxelize";
import type { VoxelVolume } from "../src/volume";

// deterministic PRNG (same generator the bench uses) so every run tests the same frames
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// centred disc with a radial colour gradient on a uniform background (bench's discFrame shape)
function discFrame(size: number, seed = 0x9e3779b9): QuantizedFrame {
  const rnd = mulberry32(seed);
  const mapColorId = new Uint8Array(size * size);
  const paletteIndex = new Int32Array(size * size);
  const c = (size - 1) / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const d = Math.hypot(x - c, y - c);
      const id = d <= r ? 2 + (Math.floor((d / r) * 200 + rnd() * 40) % 238) : 1;
      mapColorId[i] = id;
      paletteIndex[i] = id;
    }
  }
  return { width: size, height: size, mapColorId, paletteIndex };
}

function expectVolumesByteIdentical(opt: VoxelVolume, ref: VoxelVolume): void {
  expect([opt.sx, opt.sy, opt.sz]).toEqual([ref.sx, ref.sy, ref.sz]);
  expect(Buffer.compare(Buffer.from(opt.data), Buffer.from(ref.data))).toBe(0);
}

function expectSolidIdentical(frame: QuantizedFrame, opts: SolidifyImageOptions = {}): void {
  expectVolumesByteIdentical(imageToSolid(frame, opts), imageToSolidReference(frame, opts));
}

function expectVolumeIdentical(frame: QuantizedFrame, opts: VoxelizeOptions = {}): void {
  expectVolumesByteIdentical(imageToVolume(frame, opts), imageToVolumeReference(frame, opts));
}

describe("imageToSolid callback hoists are byte-identical to the verbatim reference", () => {
  const frame = discFrame(48);

  it("depthOf arrow (the video3d.ts per-frame shape), incl. NaN/Inf sanitize + one-sided", () => {
    const w = frame.width;
    const depthOf = (x: number, y: number) => ((x * 31 + y * 17) % w) / w;
    expectSolidIdentical(frame, { maxDepth: 20, depthOf });
    expectSolidIdentical(frame, { maxDepth: 7, depthOf, symmetric: false });
    // NaN / Infinity / negative returns hit the sanitize branch identically
    const dirty = (x: number, y: number) => (x % 5 === 0 ? NaN : y % 7 === 0 ? Infinity : x % 3 === 0 ? -0.4 : 0.6);
    expectSolidIdentical(frame, { maxDepth: 12, depthOf: dirty });
  });

  it("shadingOf arrow across gains and curves (and NaN sanitize)", () => {
    const shadingOf = (x: number, y: number) => ((x ^ y) % 16) / 16;
    for (const shadingGain of [0, 0.5, 1]) expectSolidIdentical(frame, { maxDepth: 16, shadingOf, shadingGain });
    expectSolidIdentical(frame, { maxDepth: 16, shadingOf, curve: 1 });
    expectSolidIdentical(frame, { maxDepth: 16, shadingOf: (x) => (x % 4 === 0 ? NaN : 0.8) });
  });

  it("isBackground arrow, auto and none backgrounds, degenerate all-background frame", () => {
    expectSolidIdentical(frame, { maxDepth: 10, isBackground: (id) => id === 1 });
    expectSolidIdentical(frame, { maxDepth: 10 }); // auto (no callback at all)
    expectSolidIdentical(frame, { maxDepth: 10, background: "none" });
    // single solid colour -> auto removal erases everything -> whole-frame-subject guard
    const flat: QuantizedFrame = {
      width: 6,
      height: 6,
      mapColorId: new Uint8Array(36).fill(9),
      paletteIndex: new Int32Array(36).fill(9),
    };
    expectSolidIdentical(flat, { maxDepth: 5 });
  });

  it("CONTRACT: this-dependent methods work when BOUND (hoisted call passes this=undefined)", () => {
    // a real method reading `this` state - passed pre-bound, so the hoisted free call and the
    // reference's `opts.depthOf(x,y)` (this=opts) resolve the SAME `this` and stay byte-identical
    const helper = {
      scale: 0.75,
      bgId: 1,
      depthOf(this: { scale: number }, x: number, y: number): number {
        return (this.scale * ((x + y) % 10)) / 10;
      },
      shadingOf(this: { scale: number }, x: number, _y: number): number {
        return this.scale * ((x % 8) / 8);
      },
      isBackground(this: { bgId: number }, id: number): boolean {
        return id === this.bgId;
      },
    };
    expectSolidIdentical(frame, { maxDepth: 14, depthOf: helper.depthOf.bind(helper) });
    expectSolidIdentical(frame, { maxDepth: 14, shadingOf: helper.shadingOf.bind(helper), shadingGain: 0.7 });
    expectSolidIdentical(frame, { maxDepth: 14, isBackground: helper.isBackground.bind(helper) });
  });
});

describe("imageToVolume heightOf memo is byte-identical to the verbatim reference", () => {
  const frame = discFrame(48, 0xbeef);

  it("relief and heightmap with a pure heightOf (incl. NaN ids) and the defaults", () => {
    const heightOf = (id: number) => (id % 13) / 13;
    expectVolumeIdentical(frame, { mode: "relief", depth: 9, heightOf });
    expectVolumeIdentical(frame, { mode: "heightmap", maxHeight: 11, heightOf });
    // NaN for some ids -> NaN run length -> fillRun writes nothing, identically
    const nanFor = (id: number) => (id % 5 === 0 ? NaN : id / 255);
    expectVolumeIdentical(frame, { mode: "relief", depth: 8, heightOf: nanFor });
    expectVolumeIdentical(frame, { mode: "heightmap", maxHeight: 8, heightOf: nanFor });
    // no heightOf at all (default () => 1) and the untouched flat mode
    expectVolumeIdentical(frame, { mode: "relief", depth: 6 });
    expectVolumeIdentical(frame, { mode: "heightmap", maxHeight: 6 });
    expectVolumeIdentical(frame, { mode: "flat", depth: 3 });
  });

  it("memo is per-invocation: heightOf runs once per DISTINCT id, and calls do not leak between invocations", () => {
    for (const mode of ["relief", "heightmap"] as const) {
      const optIds: number[] = [];
      const opt = imageToVolume(frame, { mode, depth: 8, maxHeight: 8, heightOf: (id) => (optIds.push(id), (id % 7) / 7) });
      const refCalls = { n: 0 };
      const ref = imageToVolumeReference(frame, { mode, depth: 8, maxHeight: 8, heightOf: (id) => (refCalls.n++, (id % 7) / 7) });
      expectVolumesByteIdentical(opt, ref);
      const distinct = new Set(frame.mapColorId).size;
      expect(new Set(optIds).size).toBe(distinct); // every distinct id evaluated
      expect(optIds.length).toBe(distinct); // ...exactly once (the memo)
      expect(refCalls.n).toBe(frame.width * frame.height); // reference paid one call per pixel
      // a SECOND invocation with a different mapping must re-evaluate (per-call memo, not module)
      const second = imageToVolume(frame, { mode, depth: 8, maxHeight: 8, heightOf: (id) => ((id + 1) % 7) / 7 });
      const secondRef = imageToVolumeReference(frame, { mode, depth: 8, maxHeight: 8, heightOf: (id) => ((id + 1) % 7) / 7 });
      expectVolumesByteIdentical(second, secondRef);
    }
  });
});
