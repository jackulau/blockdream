import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { generateVoxelDatapack } from "../src/datapack3d";
import { generateRgbScreenDatapack, argbInt, type RgbScreenFrame } from "../src/rgbscreen";
import { redstoneSequencer } from "../src/redstone-sequencer";

// Redstone music placement + loop lock. Repro shape: the delay line is built at
// musicOrigin (past the build box along +X) but the forceload rect only covered the
// build box, so a 199-cell track was placed into unloaded chunks and the song died.
// The rect must cover every machine setblock (at chunk granularity - forceload loads
// whole chunks between its two block corners). And the redstone branch previously
// passed no loopTicksOverride, so #mtcount was the full song length and the video
// re-phased on every wrap: both engines now lock to frames x speed.

const resolve = (id: number) => `minecraft:c${id}`;

function volumes(n: number) {
  return Array.from({ length: n }, (_, f) => {
    const v = createVolume(3, 2, 1);
    setVoxel(v, f % 3, 0, 0, 1);
    setVoxel(v, (f + 1) % 3, 1, 0, 2);
    return v;
  });
}

/** Notes every 2 ticks: a 40-tick loop keeps 20 and lays a multi-chunk track. */
const SONG: NoteEvent[] = Array.from({ length: 120 }, (_, i) => ({
  tick: i * 2,
  note: i % 25,
  instrument: i % 3 === 0 ? "harp" : i % 3 === 1 ? "bass" : "bell",
  velocity: 0.8,
}));

function parseForceload(body: string): { x0: number; z0: number; x1: number; z1: number } {
  const m = body.match(/^forceload add (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/m);
  expect(m, `no forceload add line in:\n${body}`).toBeTruthy();
  return { x0: Number(m![1]), z0: Number(m![2]), x1: Number(m![3]), z1: Number(m![4]) };
}

const chunkOf = (block: number) => Math.floor(block / 16);

function assertMachineInsideForceload(setup: string): string[] {
  const fl = parseForceload(setup);
  const machine = setup.split("\n").filter((l) => l.startsWith("setblock "));
  for (const line of machine) {
    const [, x, , z] = line.split(" ");
    const cx = chunkOf(Number(x));
    const cz = chunkOf(Number(z));
    expect(cx, `x of: ${line}`).toBeGreaterThanOrEqual(chunkOf(fl.x0));
    expect(cx, `x of: ${line}`).toBeLessThanOrEqual(chunkOf(fl.x1));
    expect(cz, `z of: ${line}`).toBeGreaterThanOrEqual(chunkOf(fl.z0));
    expect(cz, `z of: ${line}`).toBeLessThanOrEqual(chunkOf(fl.z1));
  }
  return machine;
}

describe("voxel datapack redstone music: placement + loop lock", () => {
  const vols = volumes(8); // 8 frames x speed 5 = 40-tick animation loop
  const pack = generateVoxelDatapack(vols, resolve, {
    music: SONG,
    musicEngine: "redstone",
    speedTicks: 5,
  });
  const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;

  it("the forceload rect contains every setblock of the redstone machine", () => {
    const machine = assertMachineInsideForceload(setup);
    expect(machine.length).toBeGreaterThan(50); // a real spanning delay line
    // and the machine genuinely extends past the 3-wide build box across a chunk
    // boundary (the repro shape: track outside the old build-box-only forceload)
    const xs = machine.map((l) => Number(l.split(" ")[1]));
    expect(Math.max(...xs)).toBeGreaterThan(16);
  });

  it("locks the redstone loop to the animation loop and trims out-of-loop notes", () => {
    expect(setup).toContain(`scoreboard players set #mtcount ma ${8 * 5}`);
    expect(pack.musicLoopTicks).toBe(40);
    const noteBlocks = setup.split("\n").filter((l) => l.includes("minecraft:note_block["));
    expect(noteBlocks).toHaveLength(20); // ticks 0..38, not all 120 notes
    expect(pack.musicNoteCount).toBe(20);
  });

  it("a single-frame build keeps the natural loop (last onset + tail)", () => {
    const p1 = generateVoxelDatapack(volumes(1), resolve, {
      music: SONG.slice(0, 5),
      musicEngine: "redstone",
    });
    expect(p1.musicLoopTicks).toBe(8 + 20);
    expect(p1.musicNoteCount).toBe(5);
  });
});

describe("redstoneSequencer loopTicksOverride", () => {
  it("trims notes at the loop boundary before the cap and adopts the override as loopTicks", () => {
    const seq = redstoneSequencer(SONG, { musicOrigin: { x: 0, y: 64, z: 0 }, loopTicksOverride: 6 });
    expect(seq.noteCount).toBe(3); // ticks 0, 2, 4
    expect(seq.loopTicks).toBe(6);
    expect(seq.setupScores).toContain("scoreboard players set #mtcount ma 6");
    expect(seq.blocks.filter((l) => l.includes("minecraft:note_block["))).toHaveLength(3);
  });

  it("without an override the natural loop (last onset + tail) is unchanged", () => {
    const seq = redstoneSequencer(SONG.slice(0, 3), {});
    expect(seq.loopTicks).toBe(4 + 20);
    expect(seq.noteCount).toBe(3);
  });
});

describe("rgbscreen redstone music: placement + loop lock", () => {
  function frames(n: number): RgbScreenFrame[] {
    const W = 8;
    const H = 4;
    return Array.from({ length: n }, (_, f) => {
      const argb = new Int32Array(W * H);
      for (let i = 0; i < argb.length; i++) argb[i] = argbInt((f * 30 + i) & 0xff, 5, 9);
      return { width: W, height: H, argb };
    });
  }

  it("forceload covers the delay line and #mtcount = frames x speed", () => {
    const pack = generateRgbScreenDatapack(frames(8), {
      music: SONG,
      musicEngine: "redstone",
      speedTicks: 5,
    });
    const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
    const machine = assertMachineInsideForceload(setup);
    expect(machine.length).toBeGreaterThan(50);
    expect(setup).toContain(`scoreboard players set #mtcount ma ${8 * 5}`);
    expect(pack.musicLoopTicks).toBe(40);
    expect(pack.musicNoteCount).toBe(20);
  });

  it("playsound music keyboard is inside the forceload rect too", () => {
    const pack = generateRgbScreenDatapack(frames(3), { music: SONG, speedTicks: 2 });
    const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
    assertMachineInsideForceload(setup); // rgbscreen setup setblocks == the keyboard
  });
});
