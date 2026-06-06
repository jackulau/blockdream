// Round-trip for BOTH Bedrock animation paths:
//  (a) vanilla behavior pack — simulate the emitted functions (dispatch tree → frame funcs).
//  (b) Script-API addon — simulate the POOL delta cells the runtime applies.
// Each must reconstruct every source frame exactly (Bedrock Y-flip + origin).

import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";
import { generateBedrockScriptAddon } from "../src/bedrock-script";
import { playFrames, playPool, expectedWall2D, expectGridsEqual } from "./sim";

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

const BLOCKS: Record<number, string | undefined> = {
  0: "minecraft:white_concrete",
  1: "minecraft:black_concrete",
  2: "minecraft:red_concrete",
};
const resolve = (id: number) => BLOCKS[id];
const resolveFull = (id: number) => resolve(id) ?? "minecraft:air";

const origin = { x: -3, y: 65, z: 8 };
const frames = [
  frameFromIds([[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 2, 2]]),
  frameFromIds([[1, 1, 0, 0], [0, 0, 1, 1], [2, 2, 2, 2]]), // top rows change, bottom unchanged
  frameFromIds([[1, 1, 0, 0], [0, 0, 1, 1], [0, 1, 2, 0]]), // bottom row changes
];

describe("round-trip: Bedrock behavior pack animation", () => {
  const pack = generateBedrockBehaviorPack(frames, resolve, { origin });

  it("reconstructs every frame exactly via the emitted functions", () => {
    const grids = playFrames(pack.files, "mineworld", "bedrock", frames.length);
    for (let f = 0; f < frames.length; f++) {
      expectGridsEqual(grids[f]!, expectedWall2D(frames[f]!, origin, resolveFull), expect);
    }
  });

  it("emits a tick.json driver + dispatch tree (vanilla, no macros)", () => {
    expect(pack.files.has("functions/tick.json")).toBe(true);
    expect([...pack.files.keys()].some((k) => k.includes("/dispatch/"))).toBe(true);
  });
});

describe("round-trip: Bedrock Script-API addon (POOL)", () => {
  const pack = generateBedrockScriptAddon(frames, resolve, { origin });

  it("reconstructs every frame exactly from the POOL delta cells", () => {
    const framesJs = pack.files.get("behavior_pack/scripts/frames.js")!;
    const { grids } = playPool(framesJs);
    expect(grids.length).toBe(frames.length);
    for (let f = 0; f < frames.length; f++) {
      expectGridsEqual(grids[f]!, expectedWall2D(frames[f]!, origin, resolveFull), expect);
    }
  });

  it("interns blocks into a palette and delta-encodes (frame 1 carries only changed cells)", () => {
    const { pool } = playPool(pack.files.get("behavior_pack/scripts/frames.js")!);
    expect(pool.palette).toContain("minecraft:white_concrete");
    expect(pool.frames[0].length).toBe(12); // keyframe = all 4×3 cells
    expect(pool.frames[1].length).toBe(4); // only the 4 changed top-row cells
  });
});
