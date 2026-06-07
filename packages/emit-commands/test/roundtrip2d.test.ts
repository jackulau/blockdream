// Round-trip for the 2D Java datapack animation path: emit → SIMULATE the emitted
// setblock/fill commands (keyframe + cumulative deltas, following function splits) →
// the reconstructed wall must equal every source frame. Proves the optimized 2D output
// is byte-correct, not just structurally valid.

import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { generateJavaDatapack } from "../src/datapack";
import { playFrames, expectedWall2D, expectGridsEqual } from "./sim";

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
  9: undefined, // unmapped → fallback (air)
};
const resolve = (id: number) => BLOCKS[id];
const resolveFull = (id: number) => resolve(id) ?? "minecraft:air";

describe("round-trip: 2D Java datapack animation", () => {
  const origin = { x: 10, y: 70, z: -4 };
  // solid halves → swap (full delta) → unchanged (empty delta) → single-cell change → an unmapped cell
  const frames = [
    frameFromIds([[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1]]),
    frameFromIds([[1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0]]),
    frameFromIds([[1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0]]),
    frameFromIds([[1, 1, 1, 0, 0, 0], [1, 2, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0]]),
    frameFromIds([[9, 9, 9, 9, 9, 9], [9, 9, 9, 9, 9, 9], [9, 9, 9, 9, 9, 9], [9, 9, 9, 9, 9, 9]]),
  ];
  const pack = generateJavaDatapack(frames, resolve, { origin });

  it("reconstructs every frame exactly (keyframe + cumulative deltas)", () => {
    const grids = playFrames(pack.files, "blockdream", "java", frames.length);
    expect(grids.length).toBe(frames.length);
    for (let f = 0; f < frames.length; f++) {
      expectGridsEqual(grids[f]!, expectedWall2D(frames[f]!, origin, resolveFull), expect);
    }
  });

  it("an unchanged frame emits an empty delta (no commands)", () => {
    const f2 = pack.files.get("data/blockdream/function/frames/2.mcfunction")!;
    expect(f2.split("\n").filter((l) => /^\s*(setblock|fill)\b/.test(l)).length).toBe(0);
  });

  it("the keyframe is fill-batched (2 solid halves → 2 commands, not 24 setblocks)", () => {
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    const cmds = f0.split("\n").filter((l) => /^\s*(setblock|fill)\b/.test(l));
    expect(cmds.length).toBe(2);
  });
});
