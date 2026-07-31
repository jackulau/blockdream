// --setup disclosure contract: before either live bridge carves the running world to air, the CLIs
// print the EXACT /fill bounding box + volume the clear will overwrite. These tests pin the pure
// footprint math (wallSetupFootprint / boxSetupFootprint) to the actual commands
// (buildSetupCommands / buildBoxSetupCommands derive their corners FROM the footprint, so they can
// never drift) and assert the disclosure text carries the corners + volume. All expected coordinates
// are COMPUTED numerically (negative-coordinate centers are a known past bug class - never
// string-append coordinates).

import { describe, it, expect } from "vitest";
import {
  boxSetupFootprint,
  buildBoxSetupCommands,
  buildSetupCommands,
  describeSetupFootprint,
  wallSetupFootprint,
  type SetupFootprint,
} from "../src/rcon-bridge";
import { createVolume, type VoxelVolume } from "@blockdream/voxel";

// ---------------------------------------------------------------------------
// helpers: parse emitted `fill` lines back into numeric boxes (same style as rcon-bridge.test.ts)
// ---------------------------------------------------------------------------

interface FillBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; block: string; mode: string }
function parseFill(line: string): FillBox {
  const t = line.split(/\s+/);
  expect(t[0]).toBe("fill");
  return { x0: +t[1]!, y0: +t[2]!, z0: +t[3]!, x1: +t[4]!, y1: +t[5]!, z1: +t[6]!, block: t[7]!, mode: t[8]! };
}
const boxVol = (b: FillBox): number => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);

/** The union bounds + summed volume of a set of fill commands - what the clear ACTUALLY touches. */
function fillUnion(cmds: string[]): { min: SetupFootprint["min"]; max: SetupFootprint["max"]; volume: number; blocks: Set<string> } {
  const boxes = cmds.map(parseFill);
  return {
    min: {
      x: Math.min(...boxes.map((b) => b.x0)),
      y: Math.min(...boxes.map((b) => b.y0)),
      z: Math.min(...boxes.map((b) => b.z0)),
    },
    max: {
      x: Math.max(...boxes.map((b) => b.x1)),
      y: Math.max(...boxes.map((b) => b.y1)),
      z: Math.max(...boxes.map((b) => b.z1)),
    },
    volume: boxes.reduce((s, b) => s + boxVol(b), 0),
    blocks: new Set(boxes.map((b) => b.block)),
  };
}

/** Assert the footprint IS the box the commands clear (bounds match, volumes sum, block matches). */
function expectFootprintMatchesCommands(fp: SetupFootprint, cmds: string[]): void {
  const u = fillUnion(cmds);
  expect(u.min).toEqual(fp.min);
  expect(u.max).toEqual(fp.max);
  expect(u.volume).toBe(fp.volume); // fills tile the box exactly - the disclosure volume is honest
  expect(u.blocks).toEqual(new Set([fp.clearBlock]));
}

// ---------------------------------------------------------------------------
// wallSetupFootprint - flat wall (world-model stream / --image / screenshare)
// ---------------------------------------------------------------------------

describe("wallSetupFootprint (flat wall clear box)", () => {
  const O = { x: 100, y: 64, z: -20 };
  const W = 8, H = 8, C = 3;

  it("south (default): slab W wide, H tall, +/-clearance along Z, volume W*H*(2C+1)", () => {
    const fp = wallSetupFootprint(O, W, H, { clearance: C });
    expect(fp.min).toEqual({ x: O.x, y: O.y, z: O.z - C });
    expect(fp.max).toEqual({ x: O.x + W - 1, y: O.y + H - 1, z: O.z + C });
    expect(fp.volume).toBe(W * H * (2 * C + 1));
    expect(fp.clearBlock).toBe("minecraft:air");
    expectFootprintMatchesCommands(fp, buildSetupCommands(O, W, H, { clearance: C }));
  });

  it("east: clearance runs along X (the wall normal), width along Z", () => {
    const fp = wallSetupFootprint(O, W, H, { clearance: C, facing: "east" });
    expect(fp.min).toEqual({ x: O.x - C, y: O.y, z: O.z });
    expect(fp.max).toEqual({ x: O.x + C, y: O.y + H - 1, z: O.z + W - 1 });
    expect(fp.volume).toBe((2 * C + 1) * H * W);
    expectFootprintMatchesCommands(fp, buildSetupCommands(O, W, H, { clearance: C, facing: "east" }));
  });

  it("fully negative --origin: all corners computed numerically, still matching the actual /fill", () => {
    const N = { x: -10, y: -60, z: -10 };
    const NW = 8, NH = 4;
    const fp = wallSetupFootprint(N, NW, NH, { clearance: C });
    expect(fp.min).toEqual({ x: N.x, y: N.y, z: N.z - C }); // -10,-60,-13
    expect(fp.max).toEqual({ x: N.x + NW - 1, y: N.y + NH - 1, z: N.z + C }); // -3,-57,-7
    expect(fp.min.z).toBe(-13);
    expect(fp.max).toEqual({ x: -3, y: -57, z: -7 });
    expect(fp.volume).toBe(NW * NH * (2 * C + 1));
    expectFootprintMatchesCommands(fp, buildSetupCommands(N, NW, NH, { clearance: C }));
  });

  it("an origin straddling zero (negative-to-positive box) keeps exact inclusive bounds", () => {
    const Z = { x: -2, y: -1, z: -2 };
    const fp = wallSetupFootprint(Z, 5, 3, { clearance: 2 });
    expect(fp.min).toEqual({ x: -2, y: -1, z: -4 });
    expect(fp.max).toEqual({ x: 2, y: 1, z: 0 });
    expect(fp.volume).toBe(5 * 3 * 5);
    expectFootprintMatchesCommands(fp, buildSetupCommands(Z, 5, 3, { clearance: 2 }));
  });

  it("an oversized wall (many split /fills) still sums exactly to the disclosed volume", () => {
    const fp = wallSetupFootprint(O, 200, 200, { clearance: C });
    const cmds = buildSetupCommands(O, 200, 200, { clearance: C });
    expect(cmds.length).toBeGreaterThan(1); // split at the 32768 cap
    expect(fp.volume).toBe(200 * 200 * (2 * C + 1));
    expectFootprintMatchesCommands(fp, cmds);
  });

  it("honors a custom clearBlock", () => {
    const fp = wallSetupFootprint(O, W, H, { clearance: 0, clearBlock: "minecraft:glass" });
    expect(fp.clearBlock).toBe("minecraft:glass");
    expectFootprintMatchesCommands(fp, buildSetupCommands(O, W, H, { clearance: 0, clearBlock: "minecraft:glass" }));
  });

  it("rejects a degenerate wall size (same contract as buildSetupCommands)", () => {
    expect(() => wallSetupFootprint(O, 0, 8)).toThrow(/≥ 1/);
    expect(() => wallSetupFootprint(O, 8, -1)).toThrow(/≥ 1/);
  });
});

// ---------------------------------------------------------------------------
// boxSetupFootprint - the --build W*H*D clear box
// ---------------------------------------------------------------------------

describe("boxSetupFootprint (--build clear box)", () => {
  const vol = (sx: number, sy: number, sz: number): VoxelVolume => createVolume(sx, sy, sz);

  it("positive origin: box spans origin .. origin+size-1 inclusive", () => {
    const O = { x: 10, y: -60, z: 10 };
    const fp = boxSetupFootprint(O, vol(64, 64, 16));
    expect(fp.min).toEqual({ x: O.x, y: O.y, z: O.z });
    expect(fp.max).toEqual({ x: O.x + 64 - 1, y: O.y + 64 - 1, z: O.z + 16 - 1 });
    expect(fp.volume).toBe(64 * 64 * 16);
    expectFootprintMatchesCommands(fp, buildBoxSetupCommands(O, vol(64, 64, 16)));
  });

  it("negative --origin: corners computed numerically, matching the actual /fill", () => {
    const N = { x: -50, y: 70, z: -50 };
    const fp = boxSetupFootprint(N, vol(16, 16, 16));
    expect(fp.min).toEqual({ x: N.x, y: N.y, z: N.z });
    expect(fp.max).toEqual({ x: N.x + 16 - 1, y: N.y + 16 - 1, z: N.z + 16 - 1 });
    expect(fp.max).toEqual({ x: -35, y: 85, z: -35 });
    expect(fp.volume).toBe(16 * 16 * 16);
    expectFootprintMatchesCommands(fp, buildBoxSetupCommands(N, vol(16, 16, 16)));
  });

  it("an oversized box (split /fills) sums exactly to the disclosed volume", () => {
    const N = { x: -100, y: -64, z: -100 };
    const fp = boxSetupFootprint(N, vol(64, 64, 64)); // 262144 > 32768 => split
    const cmds = buildBoxSetupCommands(N, vol(64, 64, 64));
    expect(cmds.length).toBeGreaterThan(1);
    expect(fp.volume).toBe(64 * 64 * 64);
    expectFootprintMatchesCommands(fp, cmds);
  });
});

// ---------------------------------------------------------------------------
// describeSetupFootprint - the disclosure lines the CLIs print before the clear
// ---------------------------------------------------------------------------

describe("describeSetupFootprint (disclosure text)", () => {
  it("flat wall: contains both box corners, the dimensions, the volume, and the clear block", () => {
    const O = { x: 100, y: 64, z: -20 };
    const W = 8, H = 8, C = 3;
    const fp = wallSetupFootprint(O, W, H, { clearance: C });
    const text = describeSetupFootprint("wall + viewing clearance", fp).join("\n");
    expect(text).toContain(`(${O.x},${O.y},${O.z - C})`); // min corner
    expect(text).toContain(`(${O.x + W - 1},${O.y + H - 1},${O.z + C})`); // max corner
    expect(text).toContain(`${W}x${H}x${2 * C + 1}`); // dimensions
    expect(text).toContain(String(W * H * (2 * C + 1))); // volume
    expect(text).toContain("minecraft:air");
    expect(text).toMatch(/OVERWRITE/);
    expect(text).toContain("wall + viewing clearance");
  });

  it("--build box with negative origin: corners and volume computed numerically appear verbatim", () => {
    const N = { x: -50, y: 70, z: -50 };
    const s = 16;
    const fp = boxSetupFootprint(N, { sx: s, sy: s, sz: s });
    const text = describeSetupFootprint("build", fp).join("\n");
    expect(text).toContain(`(${N.x},${N.y},${N.z})`); // (-50,70,-50)
    expect(text).toContain(`(${N.x + s - 1},${N.y + s - 1},${N.z + s - 1})`); // (-35,85,-35)
    expect(text).toContain(String(s * s * s)); // 4096
    expect(text).toContain("minecraft:air");
    expect(text).toContain("build");
  });

  it("no prompt semantics: pure lines, no trailing question or confirmation request", () => {
    const fp = wallSetupFootprint({ x: 0, y: 0, z: 0 }, 4, 4);
    const lines = describeSetupFootprint("wall", fp);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l).not.toMatch(/\?|y\/n|confirm/i);
  });
});
