import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { computeDeltas } from "../src/delta";
import { generateJavaDatapack } from "../src/datapack";

// Build a quantized frame directly from a 2D array of map color ids.
function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  const idx = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: idx, mapColorId: flat };
}

const BLOCKS = ["minecraft:white_concrete", "minecraft:black_concrete", "minecraft:red_concrete"];
const resolve = (id: number) => BLOCKS[id % BLOCKS.length];

const SETBLOCK = /^setblock -?\d+ -?\d+ -?\d+ minecraft:[a-z_]+ replace$/;

describe("delta encoding", () => {
  it("frame 0 is a full keyframe; later frames carry only changed cells", () => {
    const a = frameFromIds([
      [0, 1],
      [1, 0],
    ]);
    const b = frameFromIds([
      [0, 1],
      [2, 0], // one cell changed (1 → 2)
    ]);
    const deltas = computeDeltas([a, b]);
    expect(deltas[0]!.keyframe).toBe(true);
    expect(deltas[0]!.cells.length).toBe(4);
    expect(deltas[1]!.keyframe).toBe(false);
    expect(deltas[1]!.cells.length).toBe(1);
    expect(deltas[1]!.cells[0]).toMatchObject({ x: 0, y: 1, mapColorId: 2 });
  });
});

describe("vanilla java datapack generator", () => {
  const a = frameFromIds([
    [0, 1, 2],
    [1, 2, 0],
  ]);
  const b = frameFromIds([
    [0, 1, 2],
    [1, 1, 0], // one changed cell
  ]);
  const pack = generateJavaDatapack([a, b], resolve, { namespace: "blockdream", origin: { x: 0, y: 64, z: 0 } });

  it("emits a valid pack.mcmeta (pack_format 48)", () => {
    const meta = JSON.parse(pack.files.get("pack.mcmeta")!);
    expect(meta.pack.pack_format).toBe(48);
  });

  it("keyframe function places W·H blocks; all setblock lines are valid", () => {
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    const cmds = f0.split("\n").filter((l) => l.startsWith("setblock"));
    expect(cmds.length).toBe(2 * 3);
    expect(cmds.every((l) => SETBLOCK.test(l))).toBe(true);
  });

  it("delta function carries only the changed cell", () => {
    const f1 = pack.files.get("data/blockdream/function/frames/1.mcfunction")!;
    const cmds = f1.split("\n").filter((l) => l.startsWith("setblock"));
    expect(cmds.length).toBe(1);
    expect(SETBLOCK.test(cmds[0]!)).toBe(true);
  });

  it("places image-row 0 at the top of the wall (highest Y)", () => {
    // height 2, origin y=64 → row0 → y=65, row1 → y=64
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    expect(f0).toContain(" 65 "); // top row present
    expect(f0).toContain(" 64 "); // bottom row present
  });

  it("uses a vanilla macro for frame dispatch (no execute-if jump table)", () => {
    const play = pack.files.get("data/blockdream/function/play.mcfunction")!;
    expect(play.trim()).toBe("$function blockdream:frames/$(idx)");
  });

  it("wires a #minecraft:tick driver with scoreboard speed control", () => {
    const tick = JSON.parse(pack.files.get("data/minecraft/tags/function/tick.json")!);
    expect(tick.values).toContain("blockdream:driver");
    const driver = pack.files.get("data/blockdream/function/driver.mcfunction")!;
    expect(driver).toContain("function blockdream:play with storage blockdream:anim");
    expect(driver).toContain("#speed ma");
  });

  it("setup builds the keyframe and forceloads the build area", () => {
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain("function blockdream:frames/0");
    expect(setup).toMatch(/forceload add 0 0 2 0/);
    expect(setup).toContain("#count ma 2");
  });

  it("rejects the reserved 'minecraft' namespace", () => {
    expect(() => generateJavaDatapack([a], resolve, { namespace: "minecraft" })).toThrow();
  });
});
