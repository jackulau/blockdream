import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { QuantizedFrame } from "@blockdream/color-core";
import {
  buildMcStructure,
  buildMcStructureReference,
  readMcStructure,
  type BlockRef,
} from "../src/mcstructure";

// 2D twin of the goal-075 buildVoxelMcStructure memo: buildMcStructure now caches
// the palette index per raw mapColorId instead of re-resolving blockFor and paying
// the `${name}|${JSON.stringify(states)}` intern key PER CELL. First-sight palette
// order is preserved (scan order unchanged, blockFor pure), so the FULL serialized
// .mcstructure bytes must match the retained reference twin exactly.

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

// Adversarial resolver: ids 2 and 9 ALIAS to the same block (must share one palette
// entry), 3 and 4 carry states (exercises the JSON intern key), 5 and 0 are unmapped
// (fill fallback cells), everything else is a distinct plain block.
const blockFor = (id: number): BlockRef | undefined => {
  if (id === 2 || id === 9) return { name: "minecraft:white_concrete" };
  if (id === 3) return { name: "minecraft:oak_leaves", states: { update_bit: 0, persistent_bit: 1 } };
  if (id === 4) return { name: "minecraft:wool", states: { color: "red" } };
  if (id === 5 || id === 0) return undefined;
  return { name: `minecraft:c${id}` };
};

function frameOf(W: number, H: number, pick: (x: number, y: number) => number): QuantizedFrame {
  const mapColorId = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mapColorId[y * W + x] = pick(x, y);
  return { width: W, height: H, paletteIndex: new Int32Array(W * H), mapColorId };
}

describe("buildMcStructure (mapColorId palette-index memo)", () => {
  const CYCLE = [2, 9, 3, 4, 5, 7, 0, 11, 2, 9];

  it("is byte-identical to the reference on adversarial input (aliased ids, states, fill fallback)", () => {
    const frame = frameOf(33, 17, (x, y) => CYCLE[(x + y * 3) % CYCLE.length]!);
    const opt = buildMcStructure(frame, blockFor);
    const ref = buildMcStructureReference(frame, blockFor);
    expect(sha256(opt)).toBe(sha256(ref));
    expect(opt.equals(ref)).toBe(true);
    // aliased ids collapsed into ONE palette entry, in first-sight order
    const parsed = readMcStructure(opt);
    expect(parsed.blockNames.filter((n) => n === "minecraft:white_concrete")).toHaveLength(1);
    expect(parsed.blockNames[0]).toBe("minecraft:air"); // fill interned first
  });

  it("is byte-identical to the reference with a stateful fill, origin, and blockVersion", () => {
    const frame = frameOf(21, 9, (x, y) => (x === 0 ? 5 : CYCLE[(x * 7 + y) % CYCLE.length]!));
    const opts = {
      fill: { name: "minecraft:stone", states: { stone_type: "granite" } },
      origin: { x: -12, y: 70, z: 3 },
      blockVersion: 0x01_14_00_00,
    };
    const opt = buildMcStructure(frame, blockFor, opts);
    const ref = buildMcStructureReference(frame, blockFor, opts);
    expect(opt.equals(ref)).toBe(true);
    expect(readMcStructure(opt).origin).toEqual([-12, 70, 3]);
  });

  it("is byte-identical to the reference AND faster (same-run interleaved timing)", { retry: 2, timeout: 60000 }, () => {
    const frame = frameOf(512, 512, (x, y) => CYCLE[(x * 31 + y * 7) % CYCLE.length]!);
    // identity on the big frame first (also JIT warmup for both paths)
    expect(buildMcStructure(frame, blockFor).equals(buildMcStructureReference(frame, blockFor))).toBe(true);
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    const runRef = () => buildMcStructureReference(frame, blockFor);
    const runOpt = () => buildMcStructure(frame, blockFor);
    // interleaved rounds with ref/opt ORDER alternating each round; compare MEDIANS
    // (one GC or scheduling spike lands in an arbitrary round; the median ignores it)
    for (let iter = 0; iter < 10; iter++) {
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
    // measured ~5-15x locally; assert only strictly-faster so a busy box cannot flake
    expect(optMs).toBeLessThan(refMs);
  });
});
