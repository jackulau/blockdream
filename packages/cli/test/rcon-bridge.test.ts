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
  buildSetupCommands,
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

describe("frameToWallCommands: prevQuantized cache (live loop quantizes each frame once)", () => {
  const patched = rgbFrame(W, H, (x, y) =>
    x >= 4 && x < 8 && y >= 4 && y < 7 ? GREEN : x < W / 2 ? RED : BLUE,
  );
  // keyframe → delta → delta-back, exactly how the live paint loop drives it
  const stream = [halves, patched, halves];

  it("threading the prior .quantized back is byte-identical to re-quantizing prevFrame", () => {
    // pass A: prevQuantized omitted → prevFrame re-quantized every call (old behaviour)
    // pass B: thread the prior call's .quantized back (the live paint-loop optimization)
    let prevA: WallFrame | undefined;
    let prevB: WallFrame | undefined;
    let prevQ: WallCommands["quantized"] | undefined;
    for (const f of stream) {
      const a = frameToWallCommands(f, ORIGIN, prevA); // default opts = production path (bayer)
      const b = frameToWallCommands(f, ORIGIN, prevB, { prevQuantized: prevQ });
      expect(b.commands).toEqual(a.commands);
      expect(b.remainder).toEqual(a.remainder);
      expect([...b.quantized.mapColorId]).toEqual([...a.quantized.mapColorId]);
      prevA = f;
      prevB = f;
      prevQ = b.quantized;
    }
  });

  it("ignores a dimension-mismatched prevQuantized and re-quantizes (no stale cache)", () => {
    const stale = frameToWallCommands(rgbFrame(8, 8, () => RED), { x: 0, y: 0, z: 0 }, undefined).quantized; // 8×8
    const recompute = frameToWallCommands(patched, ORIGIN, halves); // 32×16 prevFrame, no cache
    const withStale = frameToWallCommands(patched, ORIGIN, halves, { prevQuantized: stale });
    expect(withStale.commands).toEqual(recompute.commands);
  });

  // The current-frame TEMPORAL SKIP (copy the prior index where a pixel's RGB is unchanged) must be
  // byte-identical to a full quantize. The keyframe path (no prevFrame) never temporal-skips, so its
  // .quantized IS the full from-scratch quantize — compare the live delta path's current frame to it.
  it("the temporal-skipped current frame is byte-identical to the full keyframe quantize", () => {
    const full = frameToWallCommands(patched, ORIGIN, undefined).quantized; // keyframe = full quantize (no skip)
    const q0 = frameToWallCommands(halves, ORIGIN, undefined).quantized; // prevFrame's quantize, threaded in
    const live = frameToWallCommands(patched, ORIGIN, halves, { prevQuantized: q0 }); // delta path → temporal skip
    expect([...live.quantized.paletteIndex]).toEqual([...full.paletteIndex]);
    expect([...live.quantized.mapColorId]).toEqual([...full.mapColorId]);
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

// ---------------------------------------------------------------------------
// frameToWallCommands: --facing orients the wall plane (live cast direction)
// ---------------------------------------------------------------------------

describe("frameToWallCommands: --facing orients the wall plane", () => {
  const FW = 8, FH = 6;
  const halvesXY = rgbFrame(FW, FH, (x) => (x < FW / 2 ? RED : BLUE));
  const FACINGS = ["south", "north", "east", "west"] as const;

  // distinct values seen on a constant ("plane") axis across all setblock/fill coords
  function planeAxisValues(commands: string[], axis: "x" | "z"): number[] {
    const lo = axis === "x" ? 1 : 3;
    const hi = axis === "x" ? 4 : 6;
    const vals = new Set<number>();
    for (const l of commands) {
      const t = l.split(/\s+/);
      vals.add(+t[lo]!);
      if (t[0] === "fill") vals.add(+t[hi]!);
    }
    return [...vals].sort((a, b) => a - b);
  }
  const paintedCount = (commands: string[]): number => {
    const g: Grid = new Map();
    applyCommands(commands, g);
    return g.size;
  };

  it("south (default) is byte-identical to omitting --facing (no regression)", () => {
    const a = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none" });
    const b = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: "south" });
    expect(b.commands).toEqual(a.commands);
  });

  it("south/north stand in the XY plane (z = origin.z); east/west in the ZY plane (x = origin.x)", () => {
    for (const fc of ["south", "north"] as const) {
      const c = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: fc }).commands;
      expect(planeAxisValues(c, "z")).toEqual([ORIGIN.z]); // flat in Z
    }
    for (const fc of ["east", "west"] as const) {
      const c = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: fc }).commands;
      expect(planeAxisValues(c, "x")).toEqual([ORIGIN.x]); // flat in X
    }
  });

  it("every facing paints the same number of blocks (relocated, never lost)", () => {
    const counts = FACINGS.map((fc) => paintedCount(frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: fc }).commands));
    expect(new Set(counts).size).toBe(1); // all equal
    expect(counts[0]).toBe(FW * FH); // every cell placed
  });

  it("scales: a 64×64 wall facing east stays flat in X, places all cells, and clears within the /fill cap", () => {
    const big = rgbFrame(64, 64, (x, y) => (((x + y) & 1) ? RED : BLUE)); // busy checker (worst case)
    const paint = frameToWallCommands(big, ORIGIN, undefined, { dither: "none", facing: "east" });
    expect(planeAxisValues(paint.commands, "x")).toEqual([ORIGIN.x]); // flat in X at scale
    expect(paintedCount(paint.commands)).toBe(64 * 64); // every cell placed
    const setup = buildSetupCommands(ORIGIN, 64, 64, { clearance: 3, facing: "east" });
    for (const l of setup) {
      const t = l.split(/\s+/);
      const vol = (+t[4]! - +t[1]! + 1) * (+t[5]! - +t[2]! + 1) * (+t[6]! - +t[3]! + 1);
      expect(vol).toBeLessThanOrEqual(32768); // each /fill within the vanilla cap
    }
  });

  it("east rotates the plane vs south (distinct commands), west mirrors east's column axis", () => {
    const south = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: "south" }).commands;
    const east = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: "east" }).commands;
    const west = frameToWallCommands(halvesXY, ORIGIN, undefined, { dither: "none", facing: "west" }).commands;
    expect(east).not.toEqual(south);
    // east + west span the same Z range (the wall width), but mirrored ⇒ different commands
    expect(planeAxisValues(east, "x")).toEqual(planeAxisValues(west, "x")); // both flat at origin.x
    expect(east).not.toEqual(west);
  });
});

// ---------------------------------------------------------------------------
// buildSetupCommands - the no-datapack in-world wall clear (drop-in to a running world)
// ---------------------------------------------------------------------------

interface FillBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; block: string; mode: string }
function parseFill(line: string): FillBox {
  const t = line.split(/\s+/);
  expect(t[0]).toBe("fill");
  return { x0: +t[1]!, y0: +t[2]!, z0: +t[3]!, x1: +t[4]!, y1: +t[5]!, z1: +t[6]!, block: t[7]!, mode: t[8]! };
}
const boxVol = (b: FillBox): number => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);

describe("buildSetupCommands (clear a viewing space in a RUNNING world, no datapack)", () => {
  const O = { x: 100, y: 64, z: -20 };

  it("a small wall clears as ONE /fill: slab + ±clearance on Z, to air", () => {
    const cmds = buildSetupCommands(O, 8, 8, { clearance: 3 });
    expect(cmds).toHaveLength(1);
    const b = parseFill(cmds[0]!);
    expect(b).toMatchObject({ x0: 100, y0: 64, z0: -23, x1: 107, y1: 71, z1: -17, block: "minecraft:air", mode: "replace" });
    expect(boxVol(b)).toBe(8 * 8 * 7);
  });

  it("clearance 0 clears just the wall slab (one z-plane)", () => {
    const b = parseFill(buildSetupCommands(O, 8, 8, { clearance: 0 })[0]!);
    expect([b.z0, b.z1]).toEqual([-20, -20]);
    expect(boxVol(b)).toBe(8 * 8 * 1);
  });

  it("default clearance is 3 when unspecified", () => {
    expect(buildSetupCommands(O, 8, 8)).toEqual(buildSetupCommands(O, 8, 8, { clearance: 3 }));
  });

  it("facing east carves the clearance on X and runs the wall width on Z (the ZY plane)", () => {
    const b = parseFill(buildSetupCommands(O, 8, 8, { clearance: 3, facing: "east" })[0]!);
    expect([b.x0, b.x1]).toEqual([O.x - 3, O.x + 3]); // clearance along X (the wall normal)
    expect([b.z0, b.z1]).toEqual([O.z, O.z + 7]); // wall width along Z
    expect(boxVol(b)).toBe(7 * 8 * 8);
    // south (default) is the transpose: clearance on Z, width on X
    const s = parseFill(buildSetupCommands(O, 8, 8, { clearance: 3, facing: "south" })[0]!);
    expect([s.x0, s.x1]).toEqual([O.x, O.x + 7]);
    expect([s.z0, s.z1]).toEqual([O.z - 3, O.z + 3]);
  });

  it("an oversized clear splits at the 32768 /fill cap and tiles the box exactly", () => {
    const W = 200, H = 200, C = 3;
    const cmds = buildSetupCommands(O, W, H, { clearance: C });
    expect(cmds.length).toBeGreaterThan(1);
    const boxes = cmds.map(parseFill);
    for (const b of boxes) {
      expect(b.block).toBe("minecraft:air");
      expect(boxVol(b)).toBeLessThanOrEqual(32768); // every piece within the vanilla cap
    }
    // pieces tile the full box exactly: volumes sum, and the union bounds match
    expect(boxes.reduce((s, b) => s + boxVol(b), 0)).toBe(W * H * (2 * C + 1));
    expect(Math.min(...boxes.map((b) => b.x0))).toBe(O.x);
    expect(Math.max(...boxes.map((b) => b.x1))).toBe(O.x + W - 1);
    expect(Math.min(...boxes.map((b) => b.z0))).toBe(O.z - C);
    expect(Math.max(...boxes.map((b) => b.z1))).toBe(O.z + C);
  });

  it("rejects a degenerate wall size", () => {
    expect(() => buildSetupCommands(O, 0, 8)).toThrow(/≥ 1/);
    expect(() => buildSetupCommands(O, 8, -1)).toThrow(/≥ 1/);
  });
});
