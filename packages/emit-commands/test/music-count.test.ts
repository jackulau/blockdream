import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { generateVoxelDatapack } from "../src/datapack3d";
import { generateRgbScreenDatapack, argbInt, type RgbScreenFrame } from "../src/rgbscreen";
import { noteSequencer } from "../src/note-sequencer";

// Music count honesty: the sequencer trims notes to the animation loop
// (tick < loopTicksOverride) and then caps, so callers must NOT report
// min(music.length, cap). The pack result now carries what was ACTUALLY
// emitted: musicNoteCount and musicLoopTicks (0 when there is no music).

const resolve = (id: number) => `minecraft:c${id}`;

function volume(seed: number) {
  const v = createVolume(3, 1, 1);
  setVoxel(v, seed % 3, 0, 0, 1 + (seed % 2));
  return v;
}

/** 150 notes spaced 4 ticks apart: only ticks 0 and 4 fit a 6-tick loop. */
const LONG_SONG: NoteEvent[] = Array.from({ length: 150 }, (_, i) => ({
  tick: i * 4,
  note: i % 25,
  instrument: "harp",
  velocity: 0.8,
}));

describe("music count honesty (voxel datapack)", () => {
  it("musicNoteCount = playsound lines actually emitted, musicLoopTicks = frames x speed", () => {
    const volumes = [volume(0), volume(1), volume(2)];
    const pack = generateVoxelDatapack(volumes, resolve, { music: LONG_SONG, speedTicks: 2 });
    const musicFn = pack.files.get(`data/${pack.namespace}/function/music.mcfunction`)!;
    const playsounds = musicFn.split("\n").filter((l) => l.includes("run playsound "));
    expect(playsounds).toHaveLength(2); // the repro shape: 150 reported, 2 emitted
    expect(pack.musicNoteCount).toBe(playsounds.length);
    expect(pack.musicLoopTicks).toBe(volumes.length * 2);
    // the pack's own clock agrees with the reported loop length
    const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
    expect(setup).toContain(`scoreboard players set #mtcount ma ${pack.musicLoopTicks}`);
  });

  it("a no-music build reports 0 for both fields", () => {
    const pack = generateVoxelDatapack([volume(0)], resolve, {});
    expect(pack.musicNoteCount).toBe(0);
    expect(pack.musicLoopTicks).toBe(0);
  });

  it("empty-music (music: []) reports 0 too", () => {
    const pack = generateVoxelDatapack([volume(0)], resolve, { music: [] });
    expect(pack.musicNoteCount).toBe(0);
    expect(pack.musicLoopTicks).toBe(0);
  });
});

describe("music count honesty (rgbscreen datapack)", () => {
  function frames(n: number): RgbScreenFrame[] {
    const W = 4, H = 3;
    return Array.from({ length: n }, (_, f) => {
      const argb = new Int32Array(W * H);
      for (let i = 0; i < argb.length; i++) argb[i] = argbInt((f * 40 + i) & 0xff, 10, 20);
      return { width: W, height: H, argb };
    });
  }

  it("reports emitted notes + the locked loop, not the input timeline length", () => {
    const pack = generateRgbScreenDatapack(frames(3), { music: LONG_SONG, speedTicks: 2 });
    const musicFn = pack.files.get(`data/${pack.namespace}/function/music.mcfunction`)!;
    const playsounds = musicFn.split("\n").filter((l) => l.includes("run playsound "));
    expect(pack.musicNoteCount).toBe(playsounds.length);
    expect(pack.musicNoteCount).toBe(2);
    expect(pack.musicLoopTicks).toBe(3 * 2);
  });

  it("a no-music screen reports 0 for both fields", () => {
    const pack = generateRgbScreenDatapack(frames(2), {});
    expect(pack.musicNoteCount).toBe(0);
    expect(pack.musicLoopTicks).toBe(0);
  });
});

describe("noteSequencer keyboard span", () => {
  it("exposes keyboardNotes = distinct (instrument, note) pairs for row centering", () => {
    const notes: NoteEvent[] = [
      { tick: 0, note: 12, instrument: "harp", velocity: 1 },
      { tick: 2, note: 12, instrument: "harp", velocity: 0.5 }, // duplicate pair
      { tick: 4, note: 15, instrument: "harp", velocity: 1 },
      { tick: 6, note: 12, instrument: "bell", velocity: 1 },
    ];
    const seq = noteSequencer(notes, { musicOrigin: { x: 10, y: 64, z: 0 } });
    expect(seq.noteCount).toBe(4);
    expect(seq.keyboardNotes).toBe(3); // harp:12, harp:15, bell:12
    // the physical keyboard indeed spans keyboardNotes cells along +X
    const noteBlocks = seq.keyboard.filter((l) => l.includes("note_block"));
    expect(noteBlocks).toHaveLength(seq.keyboardNotes);
    expect(noteSequencer([]).keyboardNotes).toBe(0);
  });
});
