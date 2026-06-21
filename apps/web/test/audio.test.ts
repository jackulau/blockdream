import { describe, it, expect } from "vitest";
import { audioBufferToMonoPcm, analyzeFileAudio, type AudioBufferLike, type AudioDecoder } from "../src/audio";

// The web audio path mirrors the CLI: decode the imported video's audio (here via an INJECTED fake
// decoder, since node/jsdom can't run Web Audio) → the same analyzeAudio() → a note-block timeline.
// These cover the pure downmix math + the decode→analyze glue, including the "no audio ⇒ no music"
// contract that keeps a silent or audio-less video importing fine.

function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (c: number) => channels[c]!,
  };
}

function sine(hz: number, sampleRate: number, secs: number, amp = 0.6): Float32Array {
  const n = Math.floor(sampleRate * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp;
  return out;
}

function blob(): Blob {
  // bytes are irrelevant — the injected decoder ignores them
  return new Blob([new Uint8Array([1, 2, 3])]);
}

describe("audioBufferToMonoPcm", () => {
  it("passes a mono buffer through unchanged", () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    const out = audioBufferToMonoPcm(fakeBuffer([mono], 48000));
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(out[1]).toBeCloseTo(-0.2, 6);
    expect(out[2]).toBeCloseTo(0.3, 6);
  });

  it("averages stereo channels to mono", () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([0, 0, 1]);
    const m = audioBufferToMonoPcm(fakeBuffer([l, r], 48000));
    expect(m[0]).toBeCloseTo(0.5, 6);
    expect(m[1]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it("returns an empty array for a zero-channel / empty buffer", () => {
    expect(audioBufferToMonoPcm(fakeBuffer([], 48000)).length).toBe(0);
    expect(audioBufferToMonoPcm(fakeBuffer([new Float32Array(0)], 48000)).length).toBe(0);
  });
});

describe("analyzeFileAudio", () => {
  it("transcribes a 440 Hz tone to note-block events via an injected decoder", async () => {
    const sampleRate = 22050;
    const decoder: AudioDecoder = async () => fakeBuffer([sine(440, sampleRate, 0.5)], sampleRate);
    const notes = await analyzeFileAudio(blob(), { decoder });
    expect(notes.length).toBeGreaterThan(0);
    // 440 Hz (A4) folds to note-block index 15 within the F#3..F#5 range
    expect(notes[0]!.note).toBe(15);
    expect(notes[0]!.instrument).toBe("harp");
  });

  it("honours a custom instrument", async () => {
    const sampleRate = 22050;
    const decoder: AudioDecoder = async () => fakeBuffer([sine(440, sampleRate, 0.5)], sampleRate);
    const notes = await analyzeFileAudio(blob(), { decoder, instrument: "bell" });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.instrument === "bell")).toBe(true);
  });

  it("downmixes a stereo buffer before analysis (same note as mono)", async () => {
    const sampleRate = 22050;
    const s = sine(440, sampleRate, 0.5);
    const decoder: AudioDecoder = async () => fakeBuffer([s, s], sampleRate);
    const notes = await analyzeFileAudio(blob(), { decoder });
    expect(notes[0]!.note).toBe(15);
  });

  it("returns [] (no music) when the decoder throws — e.g. a video with no audio track", async () => {
    const decoder: AudioDecoder = async () => {
      throw new Error("EncodingError: no audio");
    };
    expect(await analyzeFileAudio(blob(), { decoder })).toEqual([]);
  });

  it("returns [] for a silent / zero-length buffer", async () => {
    const decoder: AudioDecoder = async () => fakeBuffer([new Float32Array(0)], 48000);
    expect(await analyzeFileAudio(blob(), { decoder })).toEqual([]);
  });
});
