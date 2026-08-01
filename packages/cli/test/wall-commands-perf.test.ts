// Goal 088 D15a: frameToWallCommands' pending-assembly stage swapped from a `${x}|${y}|${z}`
// string-keyed Map (two object allocations per cell, the exact trap goal 050 removed from
// greedyBoxes) to a dense Int32Array slot map over the wall + carry bounding box.
//
// 1. byte-identity of the ENTIRE command/remainder output vs the verbatim pre-change function
//    (frameToWallCommandsReference) on adversarial cases: all 4 facings, carry overlapping fresh
//    delta cells (last-write-wins order), sparse deltas, full keyframes, capped remainders,
//    non-square walls, duplicate/out-of-box carry, and the far-carry sparse fallback.
// 2. a same-run interleaved A/B timing gate on the CHANGED STAGE (assemblePlacedCells vs its
//    reference twin) - order alternation + medians + retry, per the goal 067/086 lesson: gating
//    the whole frame transform would time the shared quantize/greedy floor, not the change.

import { describe, it, expect } from "vitest";
import {
  assemblePlacedCells,
  assemblePlacedCellsReference,
  frameToWallCommands,
  frameToWallCommandsReference,
  type WallCommands,
  type WallFacing,
  type WallFrame,
} from "../src/rcon-bridge";
import type { Cell, PlacedCell } from "@blockdream/emit-commands";

const FACINGS: WallFacing[] = ["south", "north", "east", "west"];
const ORIGIN = { x: -13, y: -60, z: 27 }; // negative + positive coords: slot-index offsets matter

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeFrame(w: number, h: number, seed: number): WallFrame {
  const rnd = lcg(seed);
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (rnd() * 256) | 0;
  return { width: w, height: h, pixels };
}

/** Copy `frame` with the given pixel indices recolored (a deterministic sparse delta). */
function mutate(frame: WallFrame, pixelIdxs: number[], seed: number): WallFrame {
  const rnd = lcg(seed);
  const pixels = new Uint8Array(frame.pixels);
  for (const i of pixelIdxs) {
    pixels[i * 3] = (rnd() * 256) | 0;
    pixels[i * 3 + 1] = (rnd() * 256) | 0;
    pixels[i * 3 + 2] = (rnd() * 256) | 0;
  }
  return { width: frame.width, height: frame.height, pixels };
}

function expectSame(opt: WallCommands, ref: WallCommands): void {
  expect(opt.commands).toEqual(ref.commands); // every emitted command line, in order
  expect(opt.remainder).toEqual(ref.remainder); // deferred cells, in order
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

// ---------------------------------------------------------------------------
// 1. byte-identity vs the verbatim reference
// ---------------------------------------------------------------------------

describe("frameToWallCommands dense slot map: byte-identical to the reference", () => {
  for (const facing of FACINGS) {
    it(`facing ${facing}: keyframe, capped keyframe, sparse delta, carry-overlap on a non-square wall`, () => {
      const W = 33;
      const H = 19;
      const f0 = makeFrame(W, H, 0xabc0 + FACINGS.indexOf(facing));

      // full keyframe (no prev), uncapped
      expectSame(
        frameToWallCommands(f0, ORIGIN, undefined, { facing }),
        frameToWallCommandsReference(f0, ORIGIN, undefined, { facing }),
      );

      // capped keyframe: the remainder path (slot-map lookups) is exercised
      const oCap = frameToWallCommands(f0, ORIGIN, undefined, { facing, maxCommands: 7 });
      const rCap = frameToWallCommandsReference(f0, ORIGIN, undefined, { facing, maxCommands: 7 });
      expectSame(oCap, rCap);
      expect(rCap.remainder.length).toBeGreaterThan(0); // the workload genuinely overflows the cap

      // sparse delta (a band of changed pixels wrapping across rows)
      const band = Array.from({ length: 40 }, (_, i) => 3 * W + i);
      const f1 = mutate(f0, band, 0x111);
      expectSame(
        frameToWallCommands(f1, ORIGIN, f0, { facing }),
        frameToWallCommandsReference(f1, ORIGIN, f0, { facing }),
      );

      // carry OVERLAPPING fresh delta cells: a real capped call's remainder is fed back while the
      // next frame's delta touches the same pixels - last-write-wins AND first-write position must
      // match the Map semantics exactly
      const capped = frameToWallCommandsReference(f1, ORIGIN, f0, { facing, maxCommands: 3 });
      expect(capped.remainder.length).toBeGreaterThan(0);
      const f2 = mutate(f1, band.slice(0, 25), 0x222);
      for (const maxCommands of [6, 1, undefined]) {
        expectSame(
          frameToWallCommands(f2, ORIGIN, f1, { facing, carry: capped.remainder, maxCommands }),
          frameToWallCommandsReference(f2, ORIGIN, f1, { facing, carry: capped.remainder, maxCommands }),
        );
      }
    });
  }

  it("identical frames (empty delta) with and without carry", () => {
    const f = makeFrame(24, 10, 42);
    expectSame(frameToWallCommands(f, ORIGIN, f, {}), frameToWallCommandsReference(f, ORIGIN, f, {}));
    const carry = frameToWallCommandsReference(f, ORIGIN, undefined, { maxCommands: 2 }).remainder;
    expect(carry.length).toBeGreaterThan(0);
    expectSame(
      frameToWallCommands(f, ORIGIN, f, { carry, maxCommands: 4 }),
      frameToWallCommandsReference(f, ORIGIN, f, { carry, maxCommands: 4 }),
    );
  });

  it("adversarial carry: duplicate coordinates (last wins) and cells outside the wall box", () => {
    const W = 16;
    const H = 16;
    const f0 = makeFrame(W, H, 77);
    const scattered = Array.from({ length: 48 }, (_, i) => (i * 5) % (W * H)); // spread across the wall
    const f1 = mutate(f0, scattered, 99);
    const base = frameToWallCommandsReference(f1, ORIGIN, f0, { facing: "south", maxCommands: 2 });
    expect(base.remainder.length).toBeGreaterThan(1);
    const r = base.remainder;
    const carry: PlacedCell[] = [
      ...r,
      { ...r[0]!, mapColorId: r[r.length - 1]!.mapColorId }, // duplicate coordinate: LAST value wins, FIRST position kept
      { ...r[0]!, x: r[0]!.x + W + 5 }, // right of the wall box (widens the bounding box)
      { ...r[0]!, y: r[0]!.y - 9 }, // below it
      { ...r[0]!, z: r[0]!.z + 3, mapColorId: r[1]!.mapColorId }, // off the wall plane
    ];
    const f2 = mutate(f1, [0, 1, 2], 123);
    for (const maxCommands of [4, 1, 10_000]) {
      expectSame(
        frameToWallCommands(f2, ORIGIN, f1, { carry, maxCommands }),
        frameToWallCommandsReference(f2, ORIGIN, f1, { carry, maxCommands }),
      );
    }
  });

  it("a carry cell pathologically far from the wall (dense cap exceeded) stays byte-identical via the sparse fallback", () => {
    const f0 = makeFrame(8, 8, 5);
    const seed = frameToWallCommandsReference(f0, ORIGIN, undefined, { maxCommands: 2 }).remainder;
    expect(seed.length).toBeGreaterThan(0);
    const far: PlacedCell = { ...seed[0]!, x: ORIGIN.x + 9_000_000 }; // bounding box >> MAX_DENSE_SLOTS
    for (const maxCommands of [50_000, 3]) {
      expectSame(
        frameToWallCommands(f0, ORIGIN, undefined, { carry: [far], maxCommands }),
        frameToWallCommandsReference(f0, ORIGIN, undefined, { carry: [far], maxCommands }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. perf gate on the changed stage (same-run interleaved A/B)
// ---------------------------------------------------------------------------

/** Synthetic delta cells over a W×H grid: each cell included with probability `churn`. */
function synthCells(W: number, H: number, churn: number, seed: number): Cell[] {
  const rnd = lcg(seed);
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rnd() < churn) out.push({ x, y, mapColorId: 1 + ((rnd() * 60) | 0) });
    }
  }
  return out;
}

describe("assemblePlacedCells (the changed stage)", () => {
  // 12 interleaved rounds with the ref/opt ORDER alternating each round (whoever runs second
  // inherits the first's GC debt; alternation cancels the bias), compare MEDIANS so a stray major
  // GC or scheduling spike in one round cannot poison the comparison, and retry so only a
  // sustained hostile environment - or a real regression - can fail the gate.
  it("is order/value-identical to the reference AND faster on the live-cast workload", { retry: 2, timeout: 60_000 }, () => {
    const W = 256;
    const H = 144; // the documented live screen-share wall workload: 36.8k-cell keyframes
    const origin = { x: 10, y: -60, z: 10 };
    const facing: WallFacing = "west"; // mirrored column axis: the least-trivial placement math
    const keyframe = synthCells(W, H, 1.01, 1); // every cell
    expect(keyframe.length).toBe(W * H);
    const delta = synthCells(W, H, 0.08, 2); // sparse motion delta
    const carry = assemblePlacedCellsReference(synthCells(W, H, 0.06, 3), [], origin, facing, W, H).cells;
    const runs: Array<[Cell[], PlacedCell[]]> = [
      [keyframe, []], // pure keyframe
      [delta, carry], // delta with carry, ~partial coordinate overlap
      [delta, []], // steady-state delta
      [keyframe, carry], // capped-frame recovery: keyframe over stale carry
    ];

    // identity (and JIT warmup for both paths): insertion order, values, and lookups
    for (const [cells, cy] of runs) {
      const opt = assemblePlacedCells(cells, cy, origin, facing, W, H);
      const ref = assemblePlacedCellsReference(cells, cy, origin, facing, W, H);
      expect(opt.cells).toEqual(ref.cells);
      for (let i = 0; i < ref.cells.length; i += 97) {
        const c = ref.cells[i]!;
        expect(opt.get(c.x, c.y, c.z)).toEqual(ref.get(c.x, c.y, c.z));
      }
    }
    // all 4 facings stay identical on the same inputs (placement affine vs placeCell)
    for (const f of FACINGS) {
      expect(assemblePlacedCells(delta, [], origin, f, W, H).cells).toEqual(
        assemblePlacedCellsReference(delta, [], origin, f, W, H).cells,
      );
    }

    const runOpt = (): number => {
      let n = 0;
      for (const [cells, cy] of runs) n += assemblePlacedCells(cells, cy, origin, facing, W, H).cells.length;
      return n;
    };
    const runRef = (): number => {
      let n = 0;
      for (const [cells, cy] of runs) n += assemblePlacedCellsReference(cells, cy, origin, facing, W, H).cells.length;
      return n;
    };
    expect(runOpt()).toBeGreaterThan(0);
    expect(runOpt()).toBe(runRef());

    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      for (let k = 0; k < 3; k++) fn(); // batch 3 to amortize per-call GC landing spots
      return performance.now() - t;
    };
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
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // measured ~4-8x locally; assert only strictly-faster so a busy CI box cannot flake the gate
    expect(optMs).toBeLessThan(refMs);
  });
});
