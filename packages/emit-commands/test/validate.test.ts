import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
import { generateJavaDatapack } from "../src/datapack";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";
import { computeDeltas } from "../src/delta";
import { validateCommand, validatePack, simulateDriver } from "../src/validate";

const resolve = (id: number) => ["minecraft:black_concrete", "minecraft:white_concrete"][id % 2];

function movingClip(n: number, W: number, H: number): QuantizedFrame[] {
  const frames: QuantizedFrame[] = [];
  for (let f = 0; f < n; f++) {
    const ids = new Uint8Array(W * H); // background id 0
    const ox = Math.min(f, W - 4);
    const oy = Math.min(f, H - 4);
    for (let y = oy; y < oy + 4; y++) for (let x = ox; x < ox + 4; x++) ids[y * W + x] = 1;
    frames.push({ width: W, height: H, paletteIndex: new Int32Array(W * H), mapColorId: ids });
  }
  return frames;
}

describe("command validator", () => {
  it("accepts the forms we emit", () => {
    for (const cmd of [
      "setblock 0 127 0 minecraft:white_concrete replace",
      "setblock -3 64 12 white_concrete replace",
      "function mineworld:frames/0",
      "function mineworld/dispatch/0_2",
      "$function mineworld:frames/$(idx)",
      "scoreboard objectives add ma dummy",
      "scoreboard players set #f ma 0",
      "execute if score #t ma < #speed ma run return 0",
      "execute if score f ma matches 0..1 run function mineworld/dispatch/0_1",
      "execute store result storage mineworld:anim idx int 1 run scoreboard players get #f ma",
      "forceload add 0 0 2 0",
      "tickingarea add 0 64 0 7 71 0 mineworld_area",
      "# a comment",
      "",
    ]) {
      expect(validateCommand(cmd), cmd).toBeNull();
    }
  });

  it("rejects malformed commands", () => {
    for (const bad of [
      "setblock a b c minecraft:stone",
      "setblock 0 0 0 Stone replace",
      "function not a ref",
      "execute if score a obj run function x:y",
      "scoreboard players set a",
      "frobnicate the widget",
    ]) {
      expect(validateCommand(bad), bad).not.toBeNull();
    }
  });

  it("every command in a generated Java datapack is valid", () => {
    const pack = generateJavaDatapack(movingClip(6, 16, 16), resolve, {});
    const res = validatePack(pack.files);
    expect(res.errors, JSON.stringify(res.errors.slice(0, 5))).toHaveLength(0);
  });

  it("every command in a generated Bedrock behavior pack is valid", () => {
    const pack = generateBedrockBehaviorPack(movingClip(6, 16, 16), resolve, {});
    const res = validatePack(pack.files);
    expect(res.errors, JSON.stringify(res.errors.slice(0, 5))).toHaveLength(0);
  });
});

describe("efficiency: delta encoding", () => {
  it("delta frames are far smaller than full frames on a moving clip", () => {
    const W = 32, H = 32;
    const deltas = computeDeltas(movingClip(10, W, H));
    const full = W * H;
    const avgDelta = deltas.slice(1).reduce((s, d) => s + d.cells.length, 0) / (deltas.length - 1);
    expect(deltas[0]!.cells.length).toBe(full); // keyframe is full
    expect(avgDelta / full).toBeLessThan(0.5); // deltas tiny (moving 4×4 square)
  });
});

describe("correctness: driver frame advance", () => {
  it("advances 0..N-1 then wraps, at the right cadence", () => {
    const count = 5, speed = 2;
    const seq = simulateDriver(count, speed, 2 * count * 3); // 3 loops
    expect(seq.slice(0, count)).toEqual([1, 2, 3, 4, 0]); // setup built 0; driver goes 1..4,0
    expect(seq.every((f) => f >= 0 && f < count)).toBe(true);
    // cadence: one dispatch per `speed` ticks
    expect(seq.length).toBe(count * 3);
  });
});
