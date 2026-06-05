import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
import { generateBedrockScriptAddon, buildFramesJs } from "../src/bedrock-script";

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

const BLOCKS = ["minecraft:white_concrete", "minecraft:black_concrete"];
const resolve = (id: number) => BLOCKS[id % BLOCKS.length];

function parsePool(framesJs: string): any {
  const m = /export const POOL = (\{.*\});/s.exec(framesJs);
  if (!m) throw new Error("no POOL in frames.js");
  return JSON.parse(m[1]!);
}

describe("bedrock script addon generator", () => {
  const frames = [
    frameFromIds([
      [0, 1],
      [1, 0],
    ]),
    frameFromIds([
      [0, 1],
      [1, 1], // one changed cell
    ]),
  ];
  const pack = generateBedrockScriptAddon(frames, resolve, { speedTicks: 4 });

  it("emits a valid manifest.json with a script module", () => {
    const m = JSON.parse(pack.files.get("behavior_pack/manifest.json")!);
    expect(m.format_version).toBe(2);
    expect(m.modules[0].type).toBe("script");
    expect(m.modules[0].entry).toBe("scripts/main.js");
    expect(m.dependencies[0].module_name).toBe("@minecraft/server");
  });

  it("includes a runnable main.js using the Script API tick loop", () => {
    const js = pack.files.get("behavior_pack/scripts/main.js")!;
    expect(js).toContain("system.runInterval");
    expect(js).toContain("@minecraft/server");
    expect(js).toContain('import { POOL } from "./frames.js"');
  });

  it("frames.js POOL has palette + delta frames (keyframe full, then deltas)", () => {
    const pool = parsePool(pack.files.get("behavior_pack/scripts/frames.js")!);
    expect(pool.speedTicks).toBe(4);
    expect(pool.palette).toContain("minecraft:white_concrete");
    expect(pool.frames.length).toBe(2);
    expect(pool.frames[0].length).toBe(4); // keyframe = all 4 cells
    expect(pool.frames[1].length).toBe(1); // delta = 1 changed cell
    // each cell is [x, y, paletteIndex]
    expect(pool.frames[1][0].length).toBe(3);
    expect(pool.palette[pool.frames[1][0][2]]).toMatch(/^minecraft:/);
  });

  it("buildFramesJs is deterministic for the same input", () => {
    const a = buildFramesJs(frames, resolve, { speedTicks: 4 });
    const b = buildFramesJs(frames, resolve, { speedTicks: 4 });
    expect(a).toBe(b);
  });
});
