import { describe, expect, it } from "vitest";
import { HARP_BASE_HZ, notesForFrame, noteHz } from "../src/note-preview";
import type { NoteEvent } from "@blockdream/audio";

const ev = (tick: number, note = 12): NoteEvent => ({ tick, note });

describe("notesForFrame", () => {
  it("selects exactly the notes inside the frame's tick window [f*tpf, (f+1)*tpf)", () => {
    const events = [ev(0), ev(1), ev(2), ev(3), ev(4), ev(5)];
    expect(notesForFrame(events, 0, 2).map((e) => e.tick)).toEqual([0, 1]);
    expect(notesForFrame(events, 1, 2).map((e) => e.tick)).toEqual([2, 3]);
    expect(notesForFrame(events, 2, 2).map((e) => e.tick)).toEqual([4, 5]);
    expect(notesForFrame(events, 3, 2)).toEqual([]); // beyond the timeline: silence
  });

  it("windows never overlap and never drop a note across a whole clip", () => {
    // sparse melody over 30 ticks, 3-tick frames: every note lands in exactly one frame
    const events = [ev(0), ev(4), ev(7), ev(11), ev(17), ev(23), ev(29)];
    const seen: number[] = [];
    for (let f = 0; f < 10; f++) for (const e of notesForFrame(events, f, 3)) seen.push(e.tick);
    expect(seen).toEqual(events.map((e) => e.tick));
  });
});

describe("noteHz", () => {
  it("note 12 is the harp base pitch (F#4), one octave spans note 0 to 24", () => {
    expect(noteHz(12)).toBeCloseTo(HARP_BASE_HZ, 6);
    expect(noteHz(24) / noteHz(12)).toBeCloseTo(2, 6); // +12 notes = +1 octave
    expect(noteHz(0) * 4).toBeCloseTo(noteHz(24), 6); // full window = two octaves
  });
});
