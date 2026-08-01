// Delta emit fuse: computePlacedDeltas emits WORLD-coordinate PlacedCells in one pass,
// replacing the emitters' old two-pass pipeline (computeDeltas grid cells, then a
// framePlacedCells re-map of EVERY cell solely to feed greedyBoxes - two objects per
// changed cell where one suffices). referencePlacedDeltas is the retained verbatim twin
// of that old pipeline. This locks (1) cell-for-cell identity, (2) SHA-256 identity of a
// real multi-frame pack's emitted frame lines old-vs-new for BOTH 2D emitters, and
// (3) a same-run interleaved timing gate on the extracted hot loop.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { QuantizedFrame } from "@blockdream/color-core";
import { computePlacedDeltas, referencePlacedDeltas } from "../src/delta";
import { generateJavaDatapack } from "../src/datapack";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";
import { greedyBoxes } from "../src/fill";
import { writeSplitFunction, DEFAULT_MAX_COMMANDS } from "../src/chunk";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

/** Deterministic multi-frame clip: a moving solid rectangle over LCG-noise background. */
function clip(W: number, H: number, F: number, seed = 0x5eed): QuantizedFrame[] {
  let s = seed | 0;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s;
  };
  const background = new Uint8Array(W * H);
  for (let i = 0; i < background.length; i++) background[i] = 1 + (rnd() % 4);
  return Array.from({ length: F }, (_, f) => {
    const mapColorId = new Uint8Array(background);
    const x0 = (f * 7) % Math.max(1, W - 24);
    const y0 = (f * 5) % Math.max(1, H - 16);
    for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 24; x++) mapColorId[y * W + x] = 9;
    for (let k = 0; k < (W * H) / 20; k++) mapColorId[rnd() % (W * H)] = 1 + (rnd() % 8); // per-frame churn
    return { width: W, height: H, mapColorId, paletteIndex: Int32Array.from(mapColorId) } as QuantizedFrame;
  });
}

const resolve = (id: number) => `minecraft:c${id}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("computePlacedDeltas == referencePlacedDeltas (byte-identity)", () => {
  it("cell-for-cell identical on a real multi-frame clip (order, coords, ids)", () => {
    const frames = clip(96, 64, 12);
    const origin = { x: -17, y: 60, z: 42 };
    const fused = computePlacedDeltas(frames, 64, origin);
    const ref = referencePlacedDeltas(frames, 64, origin);
    expect(fused.length).toBe(ref.length);
    for (let f = 0; f < ref.length; f++) {
      expect(fused[f]!.index).toBe(ref[f]!.index);
      expect(fused[f]!.keyframe).toBe(ref[f]!.keyframe);
      expect(fused[f]!.cells).toEqual(ref[f]!.cells);
    }
    expect(fused[0]!.cells.length).toBe(96 * 64); // keyframe = every cell
    expect(fused[1]!.cells.length).toBeGreaterThan(0); // real deltas
  });

  it("propagates the same mismatched-size error", () => {
    const frames = clip(8, 8, 2);
    frames[1] = { ...frames[1]!, width: 9 };
    expect(() => computePlacedDeltas(frames, 8, { x: 0, y: 0, z: 0 })).toThrowError(/frame 1 is 9×8, expected 8×8/);
    expect(() => referencePlacedDeltas(frames, 8, { x: 0, y: 0, z: 0 })).toThrowError(/frame 1 is 9×8, expected 8×8/);
  });
});

describe("emitted pack lines are byte-identical old-vs-new (SHA-256 A/B)", () => {
  const frames = clip(96, 64, 12);
  const origin = { x: 5, y: 64, z: -3 };
  const H = 64;

  /** Rebuild a pack's frames/* files through the RETAINED reference pipeline. */
  function referenceFrameFiles(baseDir: string, partRef: (i: number, k: number) => string, optimize: boolean): Map<string, string> {
    const files = new Map<string, string>();
    for (const d of referencePlacedDeltas(frames, H, origin)) {
      const lines = optimize
        ? greedyBoxes(d.cells, (id) => resolve(id))
        : d.cells.map((c) => `setblock ${c.x} ${c.y} ${c.z} ${resolve(c.mapColorId)} replace`);
      const header = `# frame ${d.index}${d.keyframe ? " (keyframe)" : ` (Δ ${d.cells.length})`}`;
      writeSplitFunction(files, `${baseDir}/frames/${d.index}`, lines, DEFAULT_MAX_COMMANDS, (k) => partRef(d.index, k), header);
    }
    return files;
  }

  function compareFrames(packFiles: Map<string, string>, refFiles: Map<string, string>, framePrefix: string): void {
    const packFrames = [...packFiles.keys()].filter((k) => k.startsWith(framePrefix)).sort();
    const refFrames = [...refFiles.keys()].sort();
    expect(packFrames).toEqual(refFrames);
    const packCat = packFrames.map((k) => `${k}\n${packFiles.get(k)!}`).join("");
    const refCat = refFrames.map((k) => `${k}\n${refFiles.get(k)!}`).join("");
    expect(sha(packCat)).toBe(sha(refCat));
    expect(packCat).toBe(refCat); // sha + raw equality (belt and braces)
  }

  it("generateJavaDatapack (greedyBoxes path)", () => {
    const pack = generateJavaDatapack(frames, resolve, { origin });
    compareFrames(pack.files, referenceFrameFiles("data/blockdream/function", (i, k) => `function blockdream:frames/${i}/part${k}`, true), "data/blockdream/function/frames/");
  });

  it("generateJavaDatapack (optimizeFills: false, setblock path)", () => {
    const pack = generateJavaDatapack(frames, resolve, { origin, optimizeFills: false });
    compareFrames(pack.files, referenceFrameFiles("data/blockdream/function", (i, k) => `function blockdream:frames/${i}/part${k}`, false), "data/blockdream/function/frames/");
  });

  it("generateBedrockBehaviorPack (greedyBoxes path)", () => {
    const pack = generateBedrockBehaviorPack(frames, resolve, { origin });
    compareFrames(pack.files, referenceFrameFiles("functions/blockdream", (i, k) => `function blockdream/frames/${i}/part${k}`, true), "functions/blockdream/frames/");
  });
});

describe("hot-loop timing gate (same-run interleaved, medians)", () => {
  it("the fused single pass is not slower than the retained two-pass reference", { retry: 2, timeout: 120000 }, () => {
    const frames = clip(192, 144, 24, 0xf00d);
    const origin = { x: 3, y: 70, z: -8 };
    // warmup both paths + identity spot-check
    expect(computePlacedDeltas(frames, 144, origin)[3]!.cells).toEqual(referencePlacedDeltas(frames, 144, origin)[3]!.cells);
    let sink = 0;
    const timed = (fn: () => void): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    const runRef = () => { for (const d of referencePlacedDeltas(frames, 144, origin)) sink += d.cells.length; };
    const runOpt = () => { for (const d of computePlacedDeltas(frames, 144, origin)) sink -= d.cells.length; };
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    for (let iter = 0; iter < 12; iter++) {
      if (iter % 2 === 0) {
        refTimes.push(timed(runRef));
        optTimes.push(timed(runOpt));
      } else {
        optTimes.push(timed(runOpt));
        refTimes.push(timed(runRef));
      }
    }
    expect(sink).toBe(0); // equal counts both ways; also defeats DCE
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    // generous no-regression gate: the fused pass allocates one object per cell instead of
    // two (measured ~1.5-2x faster locally); only "not meaningfully slower" is load-bearing
    expect(optMs).toBeLessThan(refMs * 1.1);
  });
});
