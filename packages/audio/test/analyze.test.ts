import { describe, it, expect } from "vitest";
import {
  analyzeAudio,
  detectPitchHz,
  hzToNoteIndex,
  noteBlockPitch,
  noteTimelineTicks,
  NOTE_BLOCK_INSTRUMENTS,
} from "../src/index";

const SR = 44100;

function sine(hz: number, ms: number, sampleRate = SR, amp = 0.9): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function silence(ms: number, sampleRate = SR): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * sampleRate));
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("note-block pitch math", () => {
  it("playsound pitch spans 0.5..2.0 across the two-octave range", () => {
    expect(noteBlockPitch(0)).toBeCloseTo(0.5, 6);
    expect(noteBlockPitch(12)).toBeCloseTo(1.0, 6);
    expect(noteBlockPitch(24)).toBeCloseTo(2.0, 6);
  });

  it("maps reference pitches to the right note-block index", () => {
    expect(hzToNoteIndex(185.0)).toBe(0); // F#3
    expect(hzToNoteIndex(440.0)).toBe(15); // A4
    expect(hzToNoteIndex(739.99)).toBe(24); // F#5
  });

  it("octave-folds out-of-range pitches into 0..24", () => {
    // A2 (110 Hz, MIDI 45) folds up one octave to the same pitch class as A3 (note 3)
    expect(hzToNoteIndex(110)).toBe(3);
    // A5 (880 Hz, MIDI 81) folds down to note 15 (same pitch class as A4)
    expect(hzToNoteIndex(880)).toBe(15);
    expect(hzToNoteIndex(0)).toBe(0);
  });
});

describe("detectPitchHz", () => {
  it("recovers the fundamental of a pure sine within a few cents", () => {
    const { hz, clarity } = detectPitchHz(sine(440, 60), SR, 110, 1200);
    expect(hz).toBeGreaterThan(435);
    expect(hz).toBeLessThan(445);
    expect(clarity).toBeGreaterThan(0.9);
  });

  it("reports no clarity on silence", () => {
    const { rms, clarity } = detectPitchHz(silence(60), SR, 110, 1200);
    expect(rms).toBeLessThan(1e-6);
    expect(clarity).toBe(0);
  });

  it("rmsGate short-circuits a sub-gate window to hz:0 without changing the reported rms", () => {
    const win = sine(440, 60, SR, 0.1); // quiet but clearly voiced; rms ≈ 0.07
    const open = detectPitchHz(win, SR, 110, 1200); // no gate → full pitch search
    const gated = detectPitchHz(win, SR, 110, 1200, 0.2); // gate above this window's rms → bail early
    expect(open.hz).toBeGreaterThan(435);
    expect(open.hz).toBeLessThan(445);
    expect(gated.hz).toBe(0);
    expect(gated.clarity).toBe(0);
    expect(gated.rms).toBe(open.rms); // identical rms → caller gates identically (output unchanged)
    // a gate below the window's rms must NOT short-circuit — full result, identical to ungated
    const below = detectPitchHz(win, SR, 110, 1200, 0.01);
    expect(below.hz).toBe(open.hz);
    expect(below.clarity).toBe(open.clarity);
  });
});

describe("analyzeAudio", () => {
  it("turns a sustained tone into a single onset at the right note", () => {
    const events = analyzeAudio(sine(440, 500), SR);
    expect(events.length).toBe(1);
    expect(events[0]!.note).toBe(15);
    expect(events[0]!.instrument).toBe("harp");
    expect(events[0]!.velocity).toBeGreaterThan(0.5);
    expect(events[0]!.tick).toBe(0);
  });

  it("transcribes an ascending scale to ascending note indices", () => {
    // F#3, A3, C#4, F#4, A4, C#5, F#5 → note indices 0,3,7,12,15,19,24
    const freqs = [185, 220, 277, 370, 440, 554, 740];
    const expected = [0, 3, 7, 12, 15, 19, 24];
    const seg = freqs.map((f) => concat(sine(f, 250), silence(80)));
    const events = analyzeAudio(concat(...seg), SR);
    expect(events.map((e) => e.note)).toEqual(expected);
    // ticks must be strictly increasing onsets
    const ticks = events.map((e) => e.tick);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
  });

  it("re-triggers the same pitch after a silent gap", () => {
    const events = analyzeAudio(concat(sine(440, 250), silence(120), sine(440, 250)), SR);
    expect(events.length).toBe(2);
    expect(events[0]!.note).toBe(15);
    expect(events[1]!.note).toBe(15);
    expect(events[1]!.tick).toBeGreaterThan(events[0]!.tick);
  });

  it("emits nothing for silence", () => {
    expect(analyzeAudio(silence(500), SR)).toEqual([]);
  });

  it("drops a tone whose RMS is below the gate (skip boundary == discard boundary)", () => {
    // the loud tone sets peak → gate = 0.04·peak; the ~40× quieter tone falls below it and is
    // gated out — exactly as before the autocorrelation skip (the skip never changes which fire)
    const loud = sine(440, 250, SR, 0.8);
    const quiet = sine(660, 250, SR, 0.02);
    const events = analyzeAudio(concat(loud, silence(80), quiet), SR);
    expect(events.map((e) => e.note)).toEqual([15]); // only A4; the quiet tone never onsets
  });

  it("emits nothing for an empty or zero-rate signal", () => {
    expect(analyzeAudio(new Float32Array(0), SR)).toEqual([]);
    expect(analyzeAudio(sine(440, 100), 0)).toEqual([]);
  });

  it("honours a custom instrument and tick rate", () => {
    const events = analyzeAudio(sine(440, 300), SR, { instrument: "bell", ticksPerSecond: 10 });
    expect(events[0]!.instrument).toBe("bell");
    expect(NOTE_BLOCK_INSTRUMENTS).toContain("bell");
  });

  it("noteTimelineTicks reports the last onset", () => {
    const events = analyzeAudio(concat(sine(220, 250), silence(80), sine(440, 250)), SR);
    expect(noteTimelineTicks(events)).toBe(events[events.length - 1]!.tick);
    expect(noteTimelineTicks([])).toBe(0);
  });
});
