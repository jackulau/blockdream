import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { noteBlockPitch } from "@blockdream/audio";
import { noteSequencer } from "../src/note-sequencer";
import { generateVoxelDatapack } from "../src/datapack3d";

const resolve = (id: number) => `minecraft:c${id}`;

function lineVolume() {
  const v = createVolume(3, 1, 1);
  setVoxel(v, 0, 0, 0, 1);
  setVoxel(v, 1, 0, 0, 1);
  setVoxel(v, 2, 0, 0, 2);
  return v;
}

const NOTES: NoteEvent[] = [
  { tick: 0, note: 15, instrument: "harp", velocity: 0.8 },
  { tick: 5, note: 0, instrument: "harp", velocity: 0.5 },
  { tick: 12, note: 24, instrument: "harp", velocity: 1.0 },
];

describe("noteSequencer", () => {
  it("places one tuned note block per distinct pitch atop its instrument base", () => {
    const seq = noteSequencer(NOTES, { musicOrigin: { x: 100, y: 64, z: 0 } });
    // distinct notes 0,15,24 sorted ascending → 3 keys at x = 100,101,102
    expect(seq.keyboard).toContain("setblock 100 63 0 minecraft:dirt replace");
    expect(seq.keyboard).toContain("setblock 100 64 0 minecraft:note_block[note=0,instrument=harp] replace");
    expect(seq.keyboard).toContain("setblock 101 64 0 minecraft:note_block[note=15,instrument=harp] replace");
    expect(seq.keyboard).toContain("setblock 102 64 0 minecraft:note_block[note=24,instrument=harp] replace");
  });

  it("emits a playsound per note at the right music-tick and pitch", () => {
    const seq = noteSequencer(NOTES, { musicOrigin: { x: 100, y: 64, z: 0 } });
    const body = seq.musicLines.join("\n");
    // note 15 at tick 0 → pitch 2^(3/12) ≈ 1.18921
    expect(noteBlockPitch(15)).toBeCloseTo(1.18921, 4);
    expect(body).toContain("if score #mt ma matches 0 run playsound minecraft:block.note_block.harp record @a 100 64 0");
    expect(body).toContain("1.18921");
    // note 0 → pitch 0.5, note 24 → pitch 2
    expect(body).toContain("matches 5 run playsound minecraft:block.note_block.harp record @a 100 64 0 1.5 0.5");
    expect(body).toContain("matches 12 run playsound minecraft:block.note_block.harp record @a 100 64 0 3 2");
    expect(body).toContain("scoreboard players add #mt ma 1");
    expect(body).toContain("execute if score #mt ma >= #mtcount ma run scoreboard players set #mt ma 0");
  });

  it("loops over (last tick + tail) and inits the music clock in setup", () => {
    const seq = noteSequencer(NOTES, { loopTailTicks: 20 });
    expect(seq.loopTicks).toBe(32); // 12 + 20
    expect(seq.setupScores).toContain("scoreboard players set #mt ma 0");
    expect(seq.setupScores).toContain("scoreboard players set #mtcount ma 32");
    expect(seq.noteCount).toBe(3);
  });

  it("emits nothing for an empty timeline", () => {
    const seq = noteSequencer([]);
    expect(seq.keyboard).toEqual([]);
    expect(seq.setupScores).toEqual([]);
    expect(seq.loopTicks).toBe(0);
    expect(seq.noteCount).toBe(0);
  });

  it("caps the number of notes so the function stays under the command limit", () => {
    const many: NoteEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      tick: i,
      note: i % 25,
      instrument: "harp",
      velocity: 0.7,
    }));
    const seq = noteSequencer(many, { maxNotes: 1500 });
    expect(seq.noteCount).toBe(1500);
  });
});

describe("generateVoxelDatapack — music is additive", () => {
  it("is byte-identical to a music-less build when music is empty or absent", () => {
    const opts = { origin: { x: 0, y: 64, z: 0 } };
    const noMusic = generateVoxelDatapack([lineVolume()], resolve, opts);
    const emptyMusic = generateVoxelDatapack([lineVolume()], resolve, { ...opts, music: [] });
    expect(Object.fromEntries(emptyMusic.files)).toEqual(Object.fromEntries(noMusic.files));
    expect(noMusic.files.has("data/blockdream/function/music.mcfunction")).toBe(false);
    expect(noMusic.files.get("data/minecraft/tags/function/tick.json")).not.toContain("blockdream:music");
  });

  it("adds the music area, the sequencer function, and the tick-tag entry when music is present", () => {
    const pack = generateVoxelDatapack([lineVolume()], resolve, {
      origin: { x: 0, y: 64, z: 0 },
      music: NOTES,
      musicOrigin: { x: 100, y: 64, z: 0 },
    });
    const music = pack.files.get("data/blockdream/function/music.mcfunction");
    expect(music).toBeDefined();
    expect(music!).toContain("playsound minecraft:block.note_block.harp");

    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain("scoreboard players set #mtcount ma 32");
    expect(setup).toContain("minecraft:note_block[note=0,instrument=harp]");
    // the physical keyboard is placed AFTER the build box is cleared (so it survives)
    expect(setup.indexOf("fill 0 64 0")).toBeLessThan(setup.indexOf("note_block"));

    const tick = pack.files.get("data/minecraft/tags/function/tick.json")!;
    expect(tick).toContain("blockdream:driver");
    expect(tick).toContain("blockdream:music");
  });
});
