// Audio extraction (Node/CLI path) — decode a media file's audio track to mono
// float32 PCM via ffmpeg, the same binary the frame extractor uses. The PCM is
// handed to @blockdream/audio for note-block transcription; this package stays
// note-agnostic (it only moves samples).

import { runFfmpeg } from "./ffmpeg";

export interface ExtractAudioOptions {
  /** Target mono sample rate in Hz (default 22050 — ample for note detection). */
  sampleRate?: number;
}

export interface ExtractedAudio {
  /** Mono float32 samples in [-1, 1]. Empty when the file has no audio. */
  pcm: Float32Array;
  sampleRate: number;
}

/**
 * True iff the media file has at least one audio stream. Parses ffmpeg's stream
 * listing (printed to stderr) so it needs no separate ffprobe binary.
 */
export function hasAudioTrack(input: string): boolean {
  // `ffmpeg -i <file>` with no output writes the stream listing to stderr and
  // exits nonzero ("At least one output file…") — expected; we only read stderr.
  const { stderr } = runFfmpeg(["-hide_banner", "-i", input]);
  return /Stream #\d+:\d+.*: Audio:/i.test(stderr);
}

/**
 * Decode the file's audio to mono float32 PCM. Returns empty PCM (not an error)
 * when the file carries no audio stream, so callers can branch on `pcm.length`.
 */
export function extractAudioPcm(input: string, opts: ExtractAudioOptions = {}): ExtractedAudio {
  const sampleRate = opts.sampleRate ?? 22050;
  if (!hasAudioTrack(input)) return { pcm: new Float32Array(0), sampleRate };

  // -vn (no video), downmix to 1 channel, resample, emit raw little-endian f32.
  const args = [
    "-v", "error", "-i", input,
    "-vn", "-ac", "1", "-ar", String(sampleRate),
    "-f", "f32le", "-",
  ];
  const { stdout, status, stderr } = runFfmpeg(args);
  if (status !== 0) {
    throw new Error(`ffmpeg audio decode failed (status ${status}): ${stderr.slice(0, 500)}`);
  }

  // Copy out sample-by-sample (readFloatLE is alignment-safe regardless of the
  // pooled Buffer's byteOffset) into a fresh, owned Float32Array.
  const n = Math.floor(stdout.length / 4);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = stdout.readFloatLE(i * 4);
  return { pcm, sampleRate };
}
