import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

const BLOCKS = ["minecraft:white_concrete", "minecraft:black_concrete", "minecraft:red_concrete"];
const resolve = (id: number) => BLOCKS[id % BLOCKS.length];
const SETBLOCK = /^setblock -?\d+ -?\d+ -?\d+ (minecraft:)?[a-z_]+ replace$/;

describe("vanilla bedrock behavior pack generator", () => {
  const frames = [
    frameFromIds([
      [0, 1, 2, 0],
      [1, 2, 0, 1],
    ]),
    frameFromIds([
      [0, 1, 2, 0],
      [1, 1, 0, 1], // one changed cell
    ]),
    frameFromIds([
      [2, 1, 2, 0],
      [1, 1, 0, 1], // one changed cell
    ]),
  ];
  const pack = generateBedrockBehaviorPack(frames, resolve, { uuids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] });

  it("emits a valid manifest.json (format_version 2, header+data module)", () => {
    const m = JSON.parse(pack.files.get("manifest.json")!);
    expect(m.format_version).toBe(2);
    expect(m.header.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.modules[0].type).toBe("data");
    expect(m.modules[0].uuid).not.toBe(m.header.uuid);
  });

  it("derives deterministic UUIDs when none supplied", () => {
    const a = generateBedrockBehaviorPack(frames, resolve);
    const b = generateBedrockBehaviorPack(frames, resolve);
    expect(JSON.parse(a.files.get("manifest.json")!).header.uuid).toBe(
      JSON.parse(b.files.get("manifest.json")!).header.uuid,
    );
  });

  it("keyframe places W·H blocks; all setblock lines valid Bedrock syntax", () => {
    const f0 = pack.files.get("functions/blockdream/frames/0.mcfunction")!;
    const cmds = f0.split("\n").filter((l) => l.startsWith("setblock"));
    expect(cmds.length).toBe(2 * 4);
    expect(cmds.every((l) => SETBLOCK.test(l))).toBe(true);
  });

  it("delta frames carry only changed cells", () => {
    const f1 = pack.files.get("functions/blockdream/frames/1.mcfunction")!;
    expect(f1.split("\n").filter((l) => l.startsWith("setblock")).length).toBe(1);
  });

  it("registers a tick.json that runs the driver every tick", () => {
    const tick = JSON.parse(pack.files.get("functions/tick.json")!);
    expect(tick.values).toContain("blockdream/driver");
  });

  it("uses a binary dispatch tree (log-depth), not an O(N) scan", () => {
    // 3 frames → root range 0_2 exists and branches to subranges
    const root = pack.files.get("functions/blockdream/dispatch/0_2.mcfunction")!;
    expect(root).toContain("matches 0..1");
    expect(root).toContain("matches 2..2");
    // a leaf calls its frame directly
    const leaf = pack.files.get("functions/blockdream/dispatch/2_2.mcfunction")!;
    expect(leaf.trim()).toBe("function blockdream/frames/2");
  });

  it("avoids `return` (unsupported on Bedrock) - uses nested guard functions", () => {
    const driver = pack.files.get("functions/blockdream/driver.mcfunction")!;
    expect(driver).not.toContain("return");
    expect(driver).toContain("run function blockdream/advance");
  });

  it("loads chunks via tickingarea and builds the keyframe in setup", () => {
    const setup = pack.files.get("functions/blockdream/setup.mcfunction")!;
    expect(setup).toContain("tickingarea add");
    expect(setup).toContain("function blockdream/frames/0");
    expect(setup).toContain("count ma 3");
  });
});
