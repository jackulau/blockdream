// Full-length-video features: the LED glow plane, the music-note cap plumb, and the
// music-loop ↔ animation-loop lock that keeps a whole-song render in sync forever.
import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { generateVoxelDatapack } from "../src/datapack3d";
import { noteSequencer } from "../src/note-sequencer";

const resolve = (id: number) => `minecraft:c${id}`;

function wallFrame(colorAt00: number) {
  const v = createVolume(2, 2, 1);
  setVoxel(v, 0, 0, 0, colorAt00);
  setVoxel(v, 1, 0, 0, 1);
  setVoxel(v, 0, 1, 0, 1);
  setVoxel(v, 1, 1, 0, 1);
  return v;
}

const notes: NoteEvent[] = [
  { tick: 0, note: 12, instrument: "harp", velocity: 1 },
  { tick: 2, note: 14, instrument: "harp", velocity: 1 },
  { tick: 5, note: 16, instrument: "harp", velocity: 1 },
];

describe("noteSequencer loopTicksOverride", () => {
  it("locks loopTicks and trims notes at/after the override BEFORE applying the cap", () => {
    const seq = noteSequencer(notes, { loopTicksOverride: 4, maxNotes: 2 });
    expect(seq.loopTicks).toBe(4);
    expect(seq.noteCount).toBe(2); // tick-5 note trimmed by the loop, not by the cap
    expect(seq.musicLines.join("\n")).not.toContain("matches 5");
    expect(seq.setupScores).toContain("scoreboard players set #mtcount ma 4");
  });

  it("without an override keeps the legacy tail behavior (byte-compat)", () => {
    const seq = noteSequencer(notes, {});
    expect(seq.loopTicks).toBe(5 + 20); // last onset + default 20-tick tail
    expect(seq.noteCount).toBe(3);
  });
});

describe("generateVoxelDatapack music scale + sync", () => {
  it("plumbs musicMaxNotes through to the sequencer", () => {
    const pack = generateVoxelDatapack([wallFrame(2), wallFrame(3)], resolve, {
      music: notes,
      musicMaxNotes: 1,
    });
    const music = pack.files.get("data/blockdream/function/music.mcfunction")!;
    expect(music.split("\n").filter((l) => l.includes("playsound"))).toHaveLength(1);
  });

  it("locks the music loop to frames × speedTicks for an animation", () => {
    const pack = generateVoxelDatapack([wallFrame(2), wallFrame(3), wallFrame(4)], resolve, {
      music: notes,
      speedTicks: 2,
    });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain("scoreboard players set #mtcount ma 6"); // 3 frames × 2 ticks
    const music = pack.files.get("data/blockdream/function/music.mcfunction")!;
    expect(music).toContain("matches 5"); // tick 5 < the 6-tick loop → kept
  });

  it("a still build keeps the song-length loop (no animation to lock to)", () => {
    const pack = generateVoxelDatapack([wallFrame(2)], resolve, { music: notes });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain(`scoreboard players set #mtcount ma ${5 + 20}`);
  });
});

describe("generateVoxelDatapack ledPlane", () => {
  it("south: places a keep-mode light plane one block outside the +Z face and widens forceload", () => {
    const pack = generateVoxelDatapack([wallFrame(2)], resolve, {
      ledPlane: "south",
      origin: { x: 10, y: 64, z: 20 },
    });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    // volume is 2x2x1 at z=20 → LED plane at z=21 spanning x 10..11, y 64..65
    expect(setup).toContain("fill 10 64 21 11 65 21 minecraft:light[level=15] keep");
    expect(setup).toContain("forceload add 10 20 11 21");
    const start = pack.files.get("data/blockdream/function/start.mcfunction")!;
    const stop = pack.files.get("data/blockdream/function/stop.mcfunction")!;
    expect(start).toContain("forceload add 10 20 11 21");
    expect(stop).toContain("forceload remove 10 20 11 21");
  });

  it("west: plane sits at x0-1", () => {
    const pack = generateVoxelDatapack([wallFrame(2)], resolve, {
      ledPlane: "west",
      origin: { x: 10, y: 64, z: 20 },
    });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain("fill 9 64 20 9 65 20 minecraft:light[level=15] keep");
  });

  it("no ledPlane → byte-identical forceload and no light fill", () => {
    const pack = generateVoxelDatapack([wallFrame(2)], resolve, { origin: { x: 10, y: 64, z: 20 } });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).not.toContain("minecraft:light");
    expect(setup).toContain("forceload add 10 20 11 20");
  });
});
