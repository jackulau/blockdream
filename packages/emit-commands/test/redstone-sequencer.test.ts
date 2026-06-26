import { describe, it, expect } from "vitest";
import type { NoteEvent } from "@blockdream/audio";
import { redstoneSequencer, distributeDelay } from "../src/redstone-sequencer";

// tick 0/5/12 game ticks → redstone ticks 0/3/6 (round(t/2)); inter-note delays 0/3/3.
const NOTES: NoteEvent[] = [
  { tick: 0, note: 15, instrument: "harp", velocity: 0.8 },
  { tick: 5, note: 0, instrument: "harp", velocity: 0.5 },
  { tick: 12, note: 24, instrument: "harp", velocity: 1.0 },
];

describe("distributeDelay", () => {
  it("splits a redstone-tick delay into repeater delays of 1..4, summing exactly", () => {
    expect(distributeDelay(0)).toEqual([]);
    expect(distributeDelay(1)).toEqual([1]);
    expect(distributeDelay(3)).toEqual([3]);
    expect(distributeDelay(4)).toEqual([4]);
    expect(distributeDelay(8)).toEqual([4, 4]);
    expect(distributeDelay(10)).toEqual([4, 4, 2]);
    for (const d of [1, 2, 3, 5, 7, 9, 13, 27]) {
      const parts = distributeDelay(d);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(d);
      expect(parts.every((p) => p >= 1 && p <= 4)).toBe(true);
    }
  });
});

describe("redstoneSequencer", () => {
  const seq = redstoneSequencer(NOTES, { musicOrigin: { x: 100, y: 64, z: 0 } });
  const blocks = seq.blocks.join("\n");

  it("places one tuned note block per note, beside the spine, on its instrument base, with air above", () => {
    // note 15 @ tap x=100, note 0 @ tap x=102, note 24 @ tap x=104 (tap row at z=1)
    expect(blocks).toContain("setblock 100 64 1 minecraft:note_block[note=15,instrument=harp] replace");
    expect(blocks).toContain("setblock 102 64 1 minecraft:note_block[note=0,instrument=harp] replace");
    expect(blocks).toContain("setblock 104 64 1 minecraft:note_block[note=24,instrument=harp] replace");
    // instrument base directly below each note block
    expect(blocks).toContain("setblock 100 63 1 minecraft:dirt replace");
    // AIR directly above every note block so it is audible
    expect(blocks).toContain("setblock 100 65 1 minecraft:air replace");
    expect(blocks).toContain("setblock 104 65 1 minecraft:air replace");
  });

  it("builds a repeater delay-line whose cumulative delay equals each note's onset", () => {
    // note 1 (rt delay 3 from note 0) → one repeater delay=3 at x=101.
    // facing=west: input/back faces the powered cell to its west, output drives east (+X).
    expect(blocks).toContain("setblock 101 64 0 minecraft:repeater[facing=west,delay=3] replace");
    // note 2 (rt delay 3 from note 1) → one repeater delay=3 at x=103
    expect(blocks).toContain("setblock 103 64 0 minecraft:repeater[facing=west,delay=3] replace");
    // tap cells carry redstone dust on the spine
    expect(blocks).toContain("setblock 100 64 0 minecraft:redstone_wire replace");
    expect(blocks).toContain("setblock 102 64 0 minecraft:redstone_wire replace");
    // total cumulative redstone-tick delay to the last note = 6 → 2 repeaters of delay 3
    const repeaterDelays = seq.blocks
      .filter((b) => b.includes("minecraft:repeater"))
      .map((b) => Number(b.match(/delay=(\d+)/)![1]));
    expect(repeaterDelays.reduce((a, b) => a + b, 0)).toBe(6); // == round(12/2)
  });

  it("exposes a pulse input one cell before the track with a re-pulse metronome", () => {
    expect(seq.inputPos).toEqual({ x: 99, y: 64, z: 0 });
    const music = seq.musicLines.join("\n");
    // ON at #mt 0 launches the wave; OFF at #mt 2 trails it (self-reset)
    expect(music).toContain("matches 0 run setblock 99 64 0 minecraft:redstone_block replace");
    expect(music).toContain("matches 2 run setblock 99 64 0 minecraft:air replace");
    expect(music).toContain("scoreboard players add #mt ma 1");
    expect(music).toContain("execute if score #mt ma >= #mtcount ma run scoreboard players set #mt ma 0");
    // a #play gate so start/stop control the metronome
    expect(music).toContain("execute unless score #play ma matches 1 run return 0");
  });

  it("loops over (last tick + tail) and inits the clock in setup", () => {
    expect(seq.loopTicks).toBe(32); // 12 + 20
    expect(seq.setupScores).toContain("scoreboard players set #mt ma 0");
    expect(seq.setupScores).toContain("scoreboard players set #mtcount ma 32");
    expect(seq.noteCount).toBe(3);
    expect(seq.length).toBe(5); // 3 tap cells + 2 repeater cells
  });

  it("sorts notes by onset before laying the track", () => {
    const shuffled: NoteEvent[] = [NOTES[2]!, NOTES[0]!, NOTES[1]!];
    const s = redstoneSequencer(shuffled, { musicOrigin: { x: 100, y: 64, z: 0 } });
    // note 15 (tick 0) must still be the first tap at x=100
    expect(s.blocks.join("\n")).toContain(
      "setblock 100 64 1 minecraft:note_block[note=15,instrument=harp] replace",
    );
  });

  it("emits nothing physical for an empty timeline", () => {
    const empty = redstoneSequencer([]);
    expect(empty.blocks).toEqual([]);
    expect(empty.setupScores).toEqual([]);
    expect(empty.loopTicks).toBe(0);
    expect(empty.noteCount).toBe(0);
    expect(empty.length).toBe(0);
  });

  it("caps the number of notes so the build stays bounded", () => {
    const many: NoteEvent[] = Array.from({ length: 5000 }, (_, i) => ({
      tick: i,
      note: i % 25,
      instrument: "harp",
      velocity: 0.7,
    }));
    const capped = redstoneSequencer(many, { maxNotes: 800 });
    expect(capped.noteCount).toBe(800);
  });
});
