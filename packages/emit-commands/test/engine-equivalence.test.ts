import { describe, it, expect } from "vitest";
import type { NoteEvent } from "@blockdream/audio";
import { noteBlockPitch } from "@blockdream/audio";
import { redstoneSequencer } from "../src/redstone-sequencer";
import { noteSequencer } from "../src/note-sequencer";

// The two --music-engine implementations must play the SAME song: redstone drives
// the note blocks with a physical repeater delay-line, playsound drives them from a
// tick function, but fed identical NoteEvents they must agree on the notes played,
// their pitches, their order, and the loop length. Each engine already has its own
// structural tests; nothing locked their EQUIVALENCE, so a refactor of one could
// silently drop, add, reorder, or mis-pitch notes and every other test stay green.
// A note block tuned `note=N` sounds at exactly noteBlockPitch(N) (vanilla mapping),
// so a redstone tap `note_block[note=N]` and a playsound at pitch noteBlockPitch(N)
// are the SAME audible pitch — that is the bridge this test asserts across.
describe("redstone <-> playsound engine equivalence", () => {
  // A varied, deliberately out-of-onset-order monophonic song across instruments,
  // with distinct ticks (no sort-stability ambiguity), well under both note caps.
  const SONG: NoteEvent[] = [
    { tick: 0, note: 12, instrument: "harp", velocity: 0.9 },
    { tick: 8, note: 7, instrument: "bass", velocity: 0.6 },
    { tick: 3, note: 19, instrument: "harp", velocity: 1.0 },
    { tick: 20, note: 0, instrument: "flute", velocity: 0.5 },
    { tick: 14, note: 24, instrument: "harp", velocity: 0.8 },
  ];
  const origin = { x: 0, y: 64, z: 0 };
  const rs = redstoneSequencer(SONG, { musicOrigin: origin });
  const ps = noteSequencer(SONG, { musicOrigin: origin });

  it("agrees on note count and loop length for the same song", () => {
    expect(rs.noteCount).toBe(SONG.length);
    expect(ps.noteCount).toBe(SONG.length);
    // both = noteTimelineTicks(SONG) + default tail (20) → identical
    expect(rs.loopTicks).toBe(ps.loopTicks);
  });

  it("the redstone engine taps every note's (pitch, instrument) in onset order — no drop, add, or reorder", () => {
    const onsetSorted = [...SONG].sort((a, b) => a.tick - b.tick);
    const rsPlayed = rs.blocks
      .map((b) => b.match(/note_block\[note=(\d+),instrument=(\w+)\]/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ note: Number(m[1]), instrument: m[2]! }));
    expect(rsPlayed).toEqual(onsetSorted.map((e) => ({ note: e.note, instrument: e.instrument })));
  });

  it("the playsound engine plays every note at the SAME audible pitch the redstone note block is tuned to", () => {
    // one playsound per note (no drop/add)
    const psPlayed = ps.musicLines
      .map((l) => l.match(/playsound minecraft:block\.note_block\.(\w+) .* ([\d.]+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ instrument: m[1]!, pitch: Number(m[2]) }));
    expect(psPlayed.length).toBe(SONG.length);
    // every input note is played at noteBlockPitch(note) on its instrument — the exact
    // pitch a note block tuned `note=N` (what the redstone engine places) produces.
    for (const e of SONG) {
      expect(
        psPlayed.some(
          (p) => p.instrument === e.instrument && Math.abs(p.pitch - noteBlockPitch(e.note)) < 1e-4,
        ),
      ).toBe(true);
    }
  });

  it("both engines stay byte-identical-empty for an empty timeline", () => {
    const rsEmpty = redstoneSequencer([]);
    const psEmpty = noteSequencer([]);
    expect(rsEmpty.noteCount).toBe(0);
    expect(psEmpty.noteCount).toBe(0);
    expect(rsEmpty.loopTicks).toBe(0);
    expect(psEmpty.loopTicks).toBe(0);
    expect(rsEmpty.setupScores).toEqual([]);
    expect(psEmpty.setupScores).toEqual([]);
  });
});
