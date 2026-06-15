// Proves the no-mod live-bridge core end-to-end (headless): RCON `data get` reply text →
// pose → serve.py action (via control-sim's deriveAction, so the schema is the contract),
// and world-model frame → quantize → delta → greedy-boxed setblock/fill wall commands that
// REPLAY through the shared Grid interpreter to a pixel-perfect wall - keyframe, delta,
// and the capped/carry degradation path.

import { describe, it, expect } from "vitest";
import {
  parsePosRotation,
  isParseError,
  poseToAction,
  frameToWallCommands,
  actionMessage,
  BTN,
  N_BUTTONS,
  type RconPose,
  type WallFrame,
} from "../src/rcon-bridge";
import { makeBlockResolver, FALLBACK_BLOCK } from "@blockdream/emit-commands";
import { getSolidBlockMapPalette } from "@blockdream/palette";
import { runFunction, expectedWall2D, expectGridsEqual, at, type Grid } from "../../emit-commands/test/sim";

// ---------------------------------------------------------------------------
// parsePosRotation
// ---------------------------------------------------------------------------

describe("parsePosRotation (vanilla 1.21 `data get entity` replies)", () => {
  it("parses concatenated Pos + Rotation replies into a full pose", () => {
    const text =
      "Steve has the following entity data: [1.5d, 64.0d, -3.25d]\n" +
      "Steve has the following entity data: [90.0f, -12.5f]";
    expect(parsePosRotation(text)).toEqual({ x: 1.5, y: 64, z: -3.25, yaw: 90, pitch: -12.5 });
  });

  it("a Pos-only reply still yields a position (rotation defaults to 0)", () => {
    const r = parsePosRotation("Steve has the following entity data: [10.5d, 70.0d, 2.0d]");
    expect(r).toEqual({ x: 10.5, y: 70, z: 2, yaw: 0, pitch: 0 });
  });

  it("a Rotation-only reply yields yaw/pitch (position defaults to 0)", () => {
    expect(parsePosRotation("[12.5f, 3.0f]")).toEqual({ x: 0, y: 0, z: 0, yaw: 12.5, pitch: 3 });
  });

  it("handles negatives and scientific notation", () => {
    const r = parsePosRotation("[ -1.0E-4d, 64.0d, 3.2E2d ]");
    expect(r).toEqual({ x: -0.0001, y: 64, z: 320, yaw: 0, pitch: 0 });
  });

  it("'No entity was found' → error", () => {
    const r = parsePosRotation("No entity was found");
    expect(isParseError(r)).toBe(true);
  });

  it("junk → error, never throws", () => {
    for (const junk of ["", "complete garbage", "[]", "[1d, banana, 3d]", "data: {a: 1b}"]) {
      let r: ReturnType<typeof parsePosRotation>;
      expect(() => (r = parsePosRotation(junk))).not.toThrow();
      expect(isParseError(r!)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// poseToAction
// ---------------------------------------------------------------------------

const P0: RconPose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };

describe("poseToAction (RCON pose deltas → serve.py action)", () => {
  it("walking the way you face → forward button (yaw 0 faces +Z)", () => {
    const a = poseToAction(P0, { ...P0, z: 0.21 }, 50);
    expect(a.buttons[BTN.forward]).toBe(1);
    expect(a.buttons[BTN.back]).toBe(0);
    expect(a.buttons[BTN.sprint]).toBe(0); // walk speed, not sprint
  });

  it("normalizes by poll interval: same velocity at dt=100ms still reads forward", () => {
    const a = poseToAction(P0, { ...P0, z: 0.42 }, 100); // 0.21 m/tick
    expect(a.buttons[BTN.forward]).toBe(1);
    expect(a.buttons[BTN.sprint]).toBe(0);
  });

  it("sprint speed sets the sprint button", () => {
    const a = poseToAction(P0, { ...P0, z: 0.28 }, 50); // > 0.25 m/tick
    expect(a.buttons[BTN.forward]).toBe(1);
    expect(a.buttons[BTN.sprint]).toBe(1);
  });

  it("facing is respected: moving -X after a 90° turn reads as forward", () => {
    const turned = { ...P0, yaw: 90 };
    const a = poseToAction(turned, { ...turned, x: -0.21 }, 50);
    expect(a.buttons[BTN.forward]).toBe(1);
  });

  it("look delta → camera in [-1,1], normalized per tick", () => {
    const a = poseToAction(P0, { ...P0, yaw: 6, pitch: -6 }, 50); // 6°/tick, 12° → 1.0
    expect(a.camera[0]).toBeCloseTo(0.5, 5);
    expect(a.camera[1]).toBeCloseTo(-0.5, 5);
    const slow = poseToAction(P0, { ...P0, yaw: 12 }, 100); // 12° over 2 ticks → 6°/tick
    expect(slow.camera[0]).toBeCloseTo(0.5, 5);
  });

  it("rising fast → jump; falling → no jump", () => {
    expect(poseToAction(P0, { ...P0, y: 64.4 }, 50).buttons[BTN.jump]).toBe(1);
    expect(poseToAction(P0, { ...P0, y: 63.6 }, 50).buttons[BTN.jump]).toBe(0);
  });

  it("standing still (and dtMs=0) → all-zero buttons, zero camera, no NaN", () => {
    const a = poseToAction(P0, P0, 0);
    expect(a.buttons).toEqual(new Array(N_BUTTONS).fill(0));
    expect(a.camera).toEqual([0, 0]);
  });

  it("message matches the serve.py schema and carries the skill", () => {
    const msg = JSON.parse(actionMessage(poseToAction(P0, { ...P0, z: 0.21 }, 50, "elytra")));
    expect(msg.type).toBe("action");
    expect(msg.buttons).toHaveLength(9);
    expect(msg.buttons.every((v: number) => v === 0 || v === 1)).toBe(true);
    expect(msg.camera).toHaveLength(2);
    expect(msg.skill).toBe("elytra");
  });
});

// ---------------------------------------------------------------------------
// makeBlockResolver (the extracted emit-commands helper)
// ---------------------------------------------------------------------------

describe("makeBlockResolver matches the palette package's solid-block mapping", () => {
  it("resolves every solid-set map colour id to the same block id", () => {
    const { blockByMapColorId } = getSolidBlockMapPalette();
    const resolve = makeBlockResolver();
    expect(blockByMapColorId.size).toBeGreaterThan(50);
    for (const [id, entry] of blockByMapColorId) expect(resolve(id)).toBe(entry.id);
  });

  it("unmapped ids fall back to air (or a custom fallback)", () => {
    expect(makeBlockResolver()(0)).toBe(FALLBACK_BLOCK);
    expect(makeBlockResolver("1.21.4", { fallbackBlock: "minecraft:glass" })(0)).toBe("minecraft:glass");
  });

  it("rejects an unknown version with a helpful error", () => {
    expect(() => makeBlockResolver("1.19")).toThrow(/unsupported/i);
  });
});

// ---------------------------------------------------------------------------
// frameToWallCommands round-trip through the Grid interpreter
// ---------------------------------------------------------------------------

const ORIGIN = { x: 100, y: 64, z: -20 };
const resolve = makeBlockResolver();

const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 60, 200];
const GREEN: [number, number, number] = [40, 180, 60];
const YELLOW: [number, number, number] = [230, 220, 60];

function rgbFrame(w: number, h: number, color: (x: number, y: number) => [number, number, number]): WallFrame {
  const pixels = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      const o = (y * w + x) * 3;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
    }
  return { width: w, height: h, pixels };
}

/** Replay emitted commands through the shared sim.ts interpreter (as one function body). */
function applyCommands(commands: string[], grid: Grid): void {
  const files = new Map([["data/t/function/f.mcfunction", commands.join("\n") + "\n"]]);
  runFunction(files, "t:f", "java", grid);
}

const W = 32, H = 16;
const halves = rgbFrame(W, H, (x) => (x < W / 2 ? RED : BLUE));

describe("frameToWallCommands: keyframe", () => {
  const res = frameToWallCommands(halves, ORIGIN, undefined, { dither: "none" });

  it("two solid halves fill-batch to exactly 2 commands, nothing deferred", () => {
    expect(res.commands).toHaveLength(2);
    expect(res.remainder).toEqual([]);
    // the solid palette covers the whole frame - no pixel degraded to the air fallback
    for (const id of res.quantized.mapColorId) expect(resolve(id)).not.toBe(FALLBACK_BLOCK);
  });

  it("replaying the commands reconstructs the quantized frame pixel-perfectly", () => {
    const grid: Grid = new Map();
    applyCommands(res.commands, grid);
    expectGridsEqual(grid, expectedWall2D(res.quantized, ORIGIN, resolve), expect);
  });

  it("the wall stands vertically: image row 0 lands at the TOP (y = origin.y + H-1)", () => {
    const grid: Grid = new Map();
    applyCommands(res.commands, grid);
    expect(grid.get(at(ORIGIN.x, ORIGIN.y + H - 1, ORIGIN.z))).toBe(resolve(res.quantized.mapColorId[0]!));
  });

  it("accepts RGBA pixels (alpha ignored) and emits identical commands", () => {
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = halves.pixels[i * 3]!;
      rgba[i * 4 + 1] = halves.pixels[i * 3 + 1]!;
      rgba[i * 4 + 2] = halves.pixels[i * 3 + 2]!;
    }
    const res4 = frameToWallCommands({ width: W, height: H, pixels: rgba }, ORIGIN, undefined, { dither: "none" });
    expect(res4.commands).toEqual(res.commands);
  });

  it("rejects malformed pixel buffers and mismatched prevFrame dims", () => {
    expect(() => frameToWallCommands({ width: W, height: H, pixels: new Uint8Array(7) }, ORIGIN)).toThrow();
    const small = rgbFrame(8, 8, () => RED);
    expect(() => frameToWallCommands(halves, ORIGIN, small, { dither: "none" })).toThrow();
  });
});

describe("frameToWallCommands: delta", () => {
  // one 4×3 green patch inside the red half changes
  const patched = rgbFrame(W, H, (x, y) =>
    x >= 4 && x < 8 && y >= 4 && y < 7 ? GREEN : x < W / 2 ? RED : BLUE,
  );

  it("only the changed patch is repainted (one fill), and the wall matches the new frame", () => {
    const grid: Grid = new Map();
    applyCommands(frameToWallCommands(halves, ORIGIN, undefined, { dither: "none" }).commands, grid);
    const res = frameToWallCommands(patched, ORIGIN, halves, { dither: "none" });
    expect(res.commands).toHaveLength(1);
    applyCommands(res.commands, grid);
    expectGridsEqual(grid, expectedWall2D(res.quantized, ORIGIN, resolve), expect);
  });

  it("an unchanged frame emits zero commands", () => {
    const res = frameToWallCommands(halves, ORIGIN, halves, { dither: "none" });
    expect(res.commands).toEqual([]);
    expect(res.remainder).toEqual([]);
  });
});

describe("frameToWallCommands: per-frame command cap", () => {
  // delta = the whole blue half turns yellow (1 big fill) + 3 scattered single pixels
  const dots: Array<[number, number]> = [[1, 1], [10, 3], [3, 12]];
  const capFrame = rgbFrame(W, H, (x, y) => {
    if (dots.some(([dx, dy]) => dx === x && dy === y)) return GREEN;
    return x < W / 2 ? RED : YELLOW;
  });

  it("under the cap nothing is deferred (4 commands total)", () => {
    const res = frameToWallCommands(capFrame, ORIGIN, halves, { dither: "none" });
    expect(res.commands).toHaveLength(4);
    expect(res.remainder).toEqual([]);
  });

  it("over the cap, the LARGEST boxes go first and the rest come back as remainder", () => {
    const res = frameToWallCommands(capFrame, ORIGIN, halves, { dither: "none", maxCommands: 1 });
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]!.startsWith("fill ")).toBe(true); // the 16×16 half, not a 1-px dot
    expect(res.remainder).toHaveLength(dots.length);
  });

  it("carrying the remainder forward converges to the exact wall", () => {
    const grid: Grid = new Map();
    applyCommands(frameToWallCommands(halves, ORIGIN, undefined, { dither: "none" }).commands, grid);

    const first = frameToWallCommands(capFrame, ORIGIN, halves, { dither: "none", maxCommands: 1 });
    applyCommands(first.commands, grid);
    let carry = first.remainder;
    let rounds = 0;
    while (carry.length > 0) {
      expect(++rounds).toBeLessThan(10);
      const step = frameToWallCommands(capFrame, ORIGIN, capFrame, { dither: "none", maxCommands: 1, carry });
      expect(step.commands.length).toBeLessThanOrEqual(1);
      applyCommands(step.commands, grid);
      carry = step.remainder;
    }
    expectGridsEqual(grid, expectedWall2D(first.quantized, ORIGIN, resolve), expect);
  });
});
