// Import a video's AUDIO track in the browser → a Minecraft note-block timeline.
// The browser already ships a Web Audio decoder (AudioContext.decodeAudioData), so - exactly like
// video.ts uses a <video> element instead of ffmpeg - we decode natively and run the SAME pure
// analyzeAudio() the CLI uses. The decode step is isolated behind an injectable AudioDecoder so the
// downmix + analysis MATH stays unit-testable without Web Audio (jsdom/node can't decode audio).

import { analyzeAudio, type NoteEvent } from "@blockdream/audio";

/** The structural slice of a Web Audio `AudioBuffer` we need (so tests can fake one). */
export interface AudioBufferLike {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** Decodes encoded media bytes into an AudioBuffer. Browser impl = AudioContext.decodeAudioData. */
export type AudioDecoder = (bytes: ArrayBuffer) => Promise<AudioBufferLike>;

/**
 * Downmix a (possibly multi-channel) AudioBuffer to one mono Float32Array by averaging channels.
 * Pure + deterministic - the unit-tested core of the web audio path.
 */
export function audioBufferToMonoPcm(buffer: AudioBufferLike): Float32Array {
  const channels = Math.max(0, buffer.numberOfChannels);
  const n = Math.max(0, buffer.length);
  const out = new Float32Array(n);
  if (channels === 0 || n === 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i]! += data[i] ?? 0;
  }
  if (channels > 1) {
    for (let i = 0; i < n; i++) out[i]! /= channels;
  }
  return out;
}

/**
 * The browser AudioDecoder: a real AudioContext.decodeAudioData. Feature-detected; throws where Web
 * Audio is unavailable (jsdom/node). decodeAudioData detaches its input, so we pass a copy and leave
 * the caller's bytes intact.
 */
export function browserAudioDecoder(): AudioDecoder {
  return async (bytes: ArrayBuffer): Promise<AudioBufferLike> => {
    const g = globalThis as unknown as {
      AudioContext?: new () => { decodeAudioData(b: ArrayBuffer): Promise<AudioBufferLike>; close?: () => void };
      webkitAudioContext?: new () => { decodeAudioData(b: ArrayBuffer): Promise<AudioBufferLike>; close?: () => void };
    };
    const Ctx = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio API not available here");
    const ctx = new Ctx();
    try {
      return await ctx.decodeAudioData(bytes.slice(0));
    } finally {
      ctx.close?.();
    }
  };
}

export interface AnalyzeFileAudioOptions {
  /** Injected decoder (defaults to the browser AudioContext one). */
  decoder?: AudioDecoder;
  /** Note-block instrument for the transcribed melody (default harp). */
  instrument?: string;
}

/**
 * Decode a media file's audio track and transcribe it to a note-block timeline. Returns [] when the
 * file has no decodable audio (a silent / video-only clip) rather than throwing - mirrors the CLI's
 * `--music auto`: no audio ⇒ no music, never an error that blocks the import.
 */
export async function analyzeFileAudio(file: Blob, opts: AnalyzeFileAudioOptions = {}): Promise<NoteEvent[]> {
  const decoder = opts.decoder ?? browserAudioDecoder();
  const bytes = await file.arrayBuffer();
  let buffer: AudioBufferLike;
  try {
    buffer = await decoder(bytes);
  } catch {
    return []; // undecodable or no audio track → no music
  }
  const pcm = audioBufferToMonoPcm(buffer);
  if (pcm.length === 0) return [];
  return analyzeAudio(pcm, buffer.sampleRate, { instrument: opts.instrument ?? "harp" });
}
