import { describe, it, expect } from "vitest";
import { buildHexTable, rgbFromFlatVol, HEX_FALLBACK } from "../src/render-tables";
import { preparePalette } from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";
import { EMPTY, type VoxelVolume } from "@blockdream/voxel";

// Showcase render table (goal 089 D12) - visual output unchanged. showcase.ts ran
// `hexByMap.get(id) ?? 0x808080` per PIXEL inside rgbFromFlatVol's double loop, over EVERY
// frame of a whole-video clip (clip.map(rgbFromFlatVol), 1500+ frames) synchronously in a
// click handler; the same Map served the viewer's colorFor. Now a module-init dense
// Int32Array(256) prefilled with the fallback serves both call sites. Locked here:
//  1. the table equals the Map lookup for the ENTIRE one-byte id space,
//  2. rgbFromFlatVol output is byte-identical to the retained verbatim reference,
//  3. the id === EMPTY ? 0 branch survives (air renders black, not fallback gray),
//  4. same-run interleaved A/B: the table loop beats the Map loop.

const pal3d = preparePalette(getSolidBlockMapPalette().palette);

/** The OLD table build, kept VERBATIM from showcase.ts - the reference twin. */
function buildHexMapReference(): Map<number, number> {
  const hexByMap = new Map<number, number>();
  for (const e of pal3d.entries) {
    const c = e.color;
    hexByMap.set(c.mapColorId, (c.r << 16) | (c.g << 8) | c.b);
  }
  return hexByMap;
}

/** The OLD per-pixel loop, kept VERBATIM (Map get + coalesce per pixel) - the reference twin. */
function rgbFromFlatVolReference(v: VoxelVolume, hexByMap: Map<number, number>): { width: number; height: number; data: Uint8Array } {
  const { sx, sy } = v;
  const data = new Uint8Array(sx * sy * 3);
  for (let iy = 0; iy < sy; iy++) {
    const wy = sy - 1 - iy; // world Y is flipped vs image rows (imageToFlat keeps builds upright)
    for (let ix = 0; ix < sx; ix++) {
      const id = v.data[ix + sx * wy]!;
      const hex = id === EMPTY ? 0 : hexByMap.get(id) ?? 0x808080;
      const j = (iy * sx + ix) * 3;
      data[j] = (hex >> 16) & 255;
      data[j + 1] = (hex >> 8) & 255;
      data[j + 2] = hex & 255;
    }
  }
  return { width: sx, height: sy, data };
}

/** Deterministic wall frames: palette ids + air (EMPTY) + ids the palette never maps. */
function wallFrames(count: number, sx: number, sy: number): VoxelVolume[] {
  let seed = 0xbadc0de;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const ids = pal3d.entries.map((e) => e.color.mapColorId);
  const frames: VoxelVolume[] = [];
  for (let f = 0; f < count; f++) {
    const data = new Uint8Array(sx * sy * 2).fill(EMPTY);
    for (let p = 0; p < sx * sy; p++) {
      const roll = rand() % 100;
      // 70% palette blocks, 15% air, 15% arbitrary bytes (unmapped ids → fallback gray)
      data[p] = roll < 70 ? ids[rand() % ids.length]! : roll < 85 ? EMPTY : rand() % 256;
    }
    frames.push({ sx, sy, sz: 2, data });
  }
  return frames;
}

describe("buildHexTable vs the retained Map reference", () => {
  it("agrees with `map.get(id) ?? 0x808080` over the ENTIRE one-byte id space", () => {
    const table = buildHexTable(pal3d.entries);
    const map = buildHexMapReference();
    expect(table.length).toBe(256);
    for (let id = 0; id < 256; id++) {
      expect(table[id], `id ${id}`).toBe(map.get(id) ?? 0x808080);
    }
    expect(HEX_FALLBACK).toBe(0x808080);
  });
});

describe("rgbFromFlatVol vs the retained verbatim reference (byte-identical)", () => {
  it("identical bytes over mixed palette/air/unmapped frames, both call-site shapes", () => {
    const table = buildHexTable(pal3d.entries);
    const map = buildHexMapReference();
    for (const [f, v] of wallFrames(6, 96, 72).entries()) {
      const opt = rgbFromFlatVol(v, table);
      const ref = rgbFromFlatVolReference(v, map);
      expect(opt.width).toBe(ref.width);
      expect(opt.height).toBe(ref.height);
      expect(Buffer.compare(Buffer.from(opt.data), Buffer.from(ref.data)), `frame ${f}`).toBe(0);
    }
  });

  it("keeps the EMPTY → black branch (air is 0x000000, unmapped ids are fallback gray)", () => {
    const table = buildHexTable(pal3d.entries);
    // sx=2, sy=1: cell0 = EMPTY (air), cell1 = an id no palette entry maps (found by probing)
    let unmapped = -1;
    const mapped = new Set(pal3d.entries.map((e) => e.color.mapColorId));
    for (let id = 0; id < 255; id++)
      if (!mapped.has(id)) {
        unmapped = id;
        break;
      }
    expect(unmapped).toBeGreaterThanOrEqual(0);
    const v: VoxelVolume = { sx: 2, sy: 1, sz: 1, data: new Uint8Array([EMPTY, unmapped]) };
    const rgb = rgbFromFlatVol(v, table);
    expect([...rgb.data]).toEqual([0, 0, 0, 0x80, 0x80, 0x80]);
  });
});

describe("hot-loop gate (same-run interleaved A/B, min of rounds)", () => {
  it("the table loop beats the Map loop on a whole-clip workload", { timeout: 60000, retry: 2 }, () => {
    const table = buildHexTable(pal3d.entries);
    const map = buildHexMapReference();
    // 160×120 = the video path's default decode grid; 24 frames per round approximates the
    // per-click clip.map(rgbFromFlatVol) burst without making the test slow.
    const frames = wallFrames(24, 160, 120);
    // warm both paths (JIT)
    for (const v of frames) {
      rgbFromFlatVolReference(v, map);
      rgbFromFlatVol(v, table);
    }
    let refMs = Infinity;
    let optMs = Infinity;
    for (let round = 0; round < 9; round++) {
      let t = performance.now();
      for (const v of frames) rgbFromFlatVolReference(v, map);
      refMs = Math.min(refMs, performance.now() - t);
      t = performance.now();
      for (const v of frames) rgbFromFlatVol(v, table);
      optMs = Math.min(optMs, performance.now() - t);
    }
    const speedup = refMs / optMs;
    console.log(
      `rgbFromFlatVol A/B (min of 9 rounds, 24×160×120 px): reference ${refMs.toFixed(2)} ms, optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(2)}x`,
    );
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.15);
  });
});

describe("showcase wiring (both call sites on the table)", () => {
  it("module-init table + colorFor + the flat-vol delegate", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const showcase = readFileSync(fileURLToPath(new URL("../src/showcase.ts", import.meta.url)), "utf8");
    expect(showcase).toContain("const hexByMap = buildHexTable(pal3d.entries)");
    expect(showcase).toContain("colorFor: (id) => hexByMap[id & 255]!");
    expect(showcase).toContain("rgbFromFlatVolTable(v, hexByMap)");
    expect(showcase).not.toContain("hexByMap.get("); // no Map lookup left on either call site
  });
});
