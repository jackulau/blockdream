import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
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

describe("command-budget splitting", () => {
  const frame = checker(10, 10); // 100 setblocks in the keyframe
  const limit = 30;

  it("java: oversized frame splits into a parent that calls ≤limit-sized parts", () => {
    const pack = generateJavaDatapack([frame], resolve, { maxCommandsPerFunction: limit });
    const parent = pack.files.get("data/mineworld/function/frames/0.mcfunction")!;
    // parent should call parts, not contain setblocks
    expect(parent).not.toContain("setblock");
    expect(parent).toContain("function mineworld:frames/0/part0");
    // 100 cells / 30 = 4 parts (30,30,30,10)
    const partPaths = [...pack.files.keys()].filter((k) => k.startsWith("data/mineworld/function/frames/0/part"));
    expect(partPaths.length).toBe(4);
    for (const p of partPaths) {
      const cmds = pack.files.get(p)!.split("\n").filter((l) => l.startsWith("setblock"));
      expect(cmds.length).toBeLessThanOrEqual(limit);
    }
  });

  it("java: small frame stays a single function (no parts)", () => {
    const small = checker(4, 4); // 16 < 30
    const pack = generateJavaDatapack([small], resolve, { maxCommandsPerFunction: limit });
    expect(pack.files.get("data/mineworld/function/frames/0.mcfunction")!).toContain("setblock");
    expect([...pack.files.keys()].some((k) => k.includes("/frames/0/part"))).toBe(false);
  });

  it("bedrock: oversized frame splits into chained sub-functions too", () => {
    const pack = generateBedrockBehaviorPack([frame], resolve, { maxCommandsPerFunction: limit });
    const parent = pack.files.get("functions/mineworld/frames/0.mcfunction")!;
    expect(parent).toContain("function mineworld/frames/0/part0");
    const parts = [...pack.files.keys()].filter((k) => k.startsWith("functions/mineworld/frames/0/part"));
    expect(parts.length).toBe(4);
  });
});
