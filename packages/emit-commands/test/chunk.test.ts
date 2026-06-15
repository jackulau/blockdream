import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { chunk } from "../src/chunk";
import { generateJavaDatapack } from "../src/datapack";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";

const resolve = (id: number) => ["minecraft:white_concrete", "minecraft:black_concrete"][id % 2];

// a single keyframe whose cell count exceeds a tiny limit
function checker(w: number, h: number): QuantizedFrame {
  const flat = new Uint8Array(w * h);
  for (let i = 0; i < flat.length; i++) flat[i] = i % 2;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

describe("chunk()", () => {
  it("splits into ceil(n/size) groups, last possibly short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

// These tests isolate the per-function SPLIT machinery (writeSplitFunction), so they
// disable the fill optimizer - otherwise greedy box-merging collapses the deliberately-
// oversized frames under the budget and there is nothing to split. The optimizer ×
// splitter composition is covered separately in greedy.test.ts / roundtrip tests.
describe("command-budget splitting", () => {
  const frame = checker(10, 10); // 100 setblocks in the keyframe
  const limit = 30;

  it("java: oversized frame splits into a parent that calls ≤limit-sized parts", () => {
    const pack = generateJavaDatapack([frame], resolve, { maxCommandsPerFunction: limit, optimizeFills: false });
    const parent = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    // parent should call parts, not contain setblocks
    expect(parent).not.toContain("setblock");
    expect(parent).toContain("function blockdream:frames/0/part0");
    // 100 cells / 30 = 4 parts (30,30,30,10)
    const partPaths = [...pack.files.keys()].filter((k) => k.startsWith("data/blockdream/function/frames/0/part"));
    expect(partPaths.length).toBe(4);
    for (const p of partPaths) {
      const cmds = pack.files.get(p)!.split("\n").filter((l) => l.startsWith("setblock"));
      expect(cmds.length).toBeLessThanOrEqual(limit);
    }
  });

  it("java: small frame stays a single function (no parts)", () => {
    const small = checker(4, 4); // 16 < 30
    const pack = generateJavaDatapack([small], resolve, { maxCommandsPerFunction: limit, optimizeFills: false });
    expect(pack.files.get("data/blockdream/function/frames/0.mcfunction")!).toContain("setblock");
    expect([...pack.files.keys()].some((k) => k.includes("/frames/0/part"))).toBe(false);
  });

  it("bedrock: oversized frame splits into chained sub-functions too", () => {
    const pack = generateBedrockBehaviorPack([frame], resolve, { maxCommandsPerFunction: limit, optimizeFills: false });
    const parent = pack.files.get("functions/blockdream/frames/0.mcfunction")!;
    expect(parent).toContain("function blockdream/frames/0/part0");
    const parts = [...pack.files.keys()].filter((k) => k.startsWith("functions/blockdream/frames/0/part"));
    expect(parts.length).toBe(4);
  });

  it("optimizer × splitter compose: a truly unmergeable frame still splits with optimization ON", () => {
    // genuine 2D checkerboard (x+y)%2 - no two neighbours share a block, so greedy
    // emits one /setblock per cell and the budget split still triggers.
    const flat = new Uint8Array(10 * 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) flat[y * 10 + x] = (x + y) % 2;
    const checker2d: QuantizedFrame = { width: 10, height: 10, paletteIndex: new Int32Array(100), mapColorId: flat };
    const pack = generateJavaDatapack([checker2d], resolve, { maxCommandsPerFunction: limit }); // optimize ON (default)
    expect(pack.totalCommands).toBe(100); // unmergeable → 100 commands
    const partPaths = [...pack.files.keys()].filter((k) => k.startsWith("data/blockdream/function/frames/0/part"));
    expect(partPaths.length).toBe(4);
  });
});
