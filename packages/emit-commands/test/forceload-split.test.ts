// /forceload 256-chunk cap guard. The music-aware forceload rect widens over the redstone
// spine (bounds.x1 = musicOrigin.x + length - 1) with the build/screen depth as its z span;
// a long spine (~2000 blocks) beside a deep build makes the rect exceed vanilla's 256-chunk
// per-command cap. forceload is the FIRST setup command, so the over-cap command was rejected
// at runtime and every later setblock fired into unloaded chunks. forceloadLines splits the
// rect into commands that each stay within the cap and whose chunk union equals the rect.

import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { forceloadLines, MAX_FORCELOAD_CHUNKS } from "../src/fill";
import { generateVoxelDatapack } from "../src/datapack3d";
import { generateRgbScreenDatapack, argbInt, type RgbScreenFrame } from "../src/rgbscreen";

const chunkOf = (b: number) => Math.floor(b / 16);

function parseRects(lines: string[], action: string): Array<{ x0: number; z0: number; x1: number; z1: number }> {
  return lines
    .map((l) => l.match(new RegExp(`^forceload ${action} (-?\\d+) (-?\\d+) (-?\\d+) (-?\\d+)$`)))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ x0: Number(m[1]), z0: Number(m[2]), x1: Number(m[3]), z1: Number(m[4]) }));
}

function chunksOfRect(r: { x0: number; z0: number; x1: number; z1: number }): string[] {
  const out: string[] = [];
  for (let cx = chunkOf(Math.min(r.x0, r.x1)); cx <= chunkOf(Math.max(r.x0, r.x1)); cx++)
    for (let cz = chunkOf(Math.min(r.z0, r.z1)); cz <= chunkOf(Math.max(r.z0, r.z1)); cz++) out.push(`${cx},${cz}`);
  return out;
}

/** Every command <= cap; commands never overlap; union == the block rect's chunk set. */
function assertSplitCovers(lines: string[], action: string, rect: { x0: number; z0: number; x1: number; z1: number }): void {
  const rects = parseRects(lines, action);
  expect(rects.length).toBe(lines.length); // every line parsed
  const want = new Set(chunksOfRect(rect));
  const got = new Set<string>();
  let total = 0;
  for (const r of rects) {
    const chunks = chunksOfRect(r);
    expect(chunks.length, `chunks of: forceload ${action} ${r.x0} ${r.z0} ${r.x1} ${r.z1}`).toBeLessThanOrEqual(MAX_FORCELOAD_CHUNKS);
    total += chunks.length;
    for (const c of chunks) got.add(c);
  }
  expect(got).toEqual(want); // union == the rect
  expect(total).toBe(want.size); // and no tile overlaps
}

describe("forceloadLines (256-chunk cap split)", () => {
  it("a rect within the cap stays ONE command with the caller's exact block coords", () => {
    expect(forceloadLines(0, 0, 47, 15, "add")).toEqual(["forceload add 0 0 47 15"]);
    expect(forceloadLines(-160, -32, 159, -17, "add")).toEqual(["forceload add -160 -32 159 -17"]); // 20x1 chunks, negative coords
    expect(forceloadLines(3, 5, 3, 5, "remove")).toEqual(["forceload remove 3 5 3 5"]);
  });

  it("an over-cap rect splits into <=256-chunk commands whose union equals the rect", () => {
    // 200 x 5 chunks = 1000 (the long-spine-beside-a-deep-build shape)
    const rect = { x0: 0, z0: 0, x1: 3199, z1: 79 };
    const lines = forceloadLines(rect.x0, rect.z0, rect.x1, rect.z1, "add");
    expect(lines.length).toBeGreaterThan(1);
    assertSplitCovers(lines, "add", rect);
  });

  it("splits along x too when a single chunk row exceeds the cap, and for remove", () => {
    const rect = { x0: 0, z0: 0, x1: 300 * 16 - 1, z1: 15 }; // 300 x 1 chunks
    for (const action of ["add", "remove"] as const) {
      const lines = forceloadLines(rect.x0, rect.z0, rect.x1, rect.z1, action);
      expect(lines.length).toBe(2); // 256 + 44
      assertSplitCovers(lines, action, rect);
    }
  });

  it("handles negative, unnormalized over-cap rects", () => {
    const rect = { x0: 2400, z0: 100, x1: -2400, z1: -100 }; // reversed corners, 301 x 13 chunks
    assertSplitCovers(forceloadLines(rect.x0, rect.z0, rect.x1, rect.z1, "add"), "add", rect);
  });
});

/** 400 notes spaced 10 ticks: rt gap 5 = 2 repeaters + 1 tap per note, a ~1200-cell spine. */
const LONG_SONG: NoteEvent[] = Array.from({ length: 400 }, (_, i) => ({
  tick: i * 10,
  note: i % 25,
  instrument: "harp",
  velocity: 0.8,
}));

const resolve = (id: number) => `minecraft:c${id}`;

function setblockChunks(body: string): Array<[number, number]> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("setblock "))
    .map((l) => {
      const [, x, , z] = l.split(" ");
      return [chunkOf(Number(x)), chunkOf(Number(z))];
    });
}

describe("voxel datapack: over-cap forceload rect is split (redstone spine x deep build)", () => {
  // single frame => the natural loop keeps all 400 notes; sz 64 => 4 chunk rows of build depth
  const v = createVolume(3, 2, 64);
  setVoxel(v, 0, 0, 0, 1);
  setVoxel(v, 2, 1, 63, 2);
  const pack = generateVoxelDatapack([v], resolve, { music: LONG_SONG, musicEngine: "redstone" });
  const fn = (name: string) => pack.files.get(`data/${pack.namespace}/function/${name}.mcfunction`)!;

  it("setup emits multiple forceload adds, each <=256 chunks, covering the whole machine", () => {
    const setup = fn("setup");
    const adds = setup.split("\n").filter((l) => l.startsWith("forceload add "));
    expect(adds.length).toBeGreaterThan(1); // the repro: one over-cap command before
    const rects = parseRects(adds, "add");
    const union = new Set<string>();
    for (const r of rects) {
      expect(chunksOfRect(r).length).toBeLessThanOrEqual(MAX_FORCELOAD_CHUNKS);
      for (const c of chunksOfRect(r)) union.add(c);
    }
    expect(union.size).toBeGreaterThan(MAX_FORCELOAD_CHUNKS); // genuinely over-cap rect
    // every machine setblock (spine + note blocks) lands in a forceloaded chunk
    for (const [cx, cz] of setblockChunks(setup)) expect(union.has(`${cx},${cz}`), `chunk ${cx},${cz}`).toBe(true);
  });

  it("start re-adds and stop removes the SAME chunk set (symmetric lifecycle)", () => {
    const addUnion = new Set(parseRects(fn("start").split("\n"), "add").flatMap(chunksOfRect));
    const removeUnion = new Set(parseRects(fn("stop").split("\n"), "remove").flatMap(chunksOfRect));
    expect(addUnion.size).toBeGreaterThan(MAX_FORCELOAD_CHUNKS);
    expect(removeUnion).toEqual(addUnion);
  });
});

describe("rgbscreen datapack: over-cap forceload rect is split", () => {
  it("every forceload command in setup/teardown stays within the cap", () => {
    // 700 notes spaced 12 ticks: rt gap 6 = 2 repeaters + tap, a ~2100-cell spine; musicOrigin
    // z=15 puts the tap row across a chunk seam => 2 z-rows x ~132 x-chunks > 256.
    const song: NoteEvent[] = Array.from({ length: 700 }, (_, i) => ({
      tick: i * 12,
      note: i % 25,
      instrument: "bass",
      velocity: 0.7,
    }));
    const frame: RgbScreenFrame = {
      width: 8,
      height: 4,
      argb: Int32Array.from({ length: 32 }, (_, i) => argbInt(i * 7, 3, 200)),
    };
    const pack = generateRgbScreenDatapack([frame], {
      music: song,
      musicEngine: "redstone",
      musicOrigin: { x: 10, y: 64, z: 15 },
    });
    for (const name of ["setup", "teardown"]) {
      const body = pack.files.get(`data/${pack.namespace}/function/${name}.mcfunction`)!;
      const cmds = body.split("\n").filter((l) => l.startsWith("forceload "));
      expect(cmds.length, name).toBeGreaterThan(1);
      for (const action of ["add", "remove"] as const) {
        for (const r of parseRects(cmds, action)) {
          expect(chunksOfRect(r).length).toBeLessThanOrEqual(MAX_FORCELOAD_CHUNKS);
        }
      }
    }
    // and the machine is fully inside the added union
    const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
    const union = new Set(parseRects(setup.split("\n"), "add").flatMap(chunksOfRect));
    for (const [cx, cz] of setblockChunks(setup)) expect(union.has(`${cx},${cz}`), `chunk ${cx},${cz}`).toBe(true);
  });
});
