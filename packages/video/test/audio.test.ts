import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "../src/ffmpeg";
import { extractAudioPcm, hasAudioTrack } from "../src/audio";

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let toneWav: string;
let videoWithAudio: string;
let videoNoAudio: string;

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-audio-"));
  toneWav = join(dir, "tone.wav");
  videoWithAudio = join(dir, "av.mp4");
  videoNoAudio = join(dir, "silent.mp4");

  // 440 Hz sine, 1s mono WAV.
  let r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-y", toneWav]);
  if (r.status !== 0) throw new Error("ffmpeg tone gen failed: " + r.stderr);

  // A video that carries both a video stream AND a 440 Hz audio track.
  r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-pix_fmt", "yuv420p", "-y", videoWithAudio,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg av gen failed: " + r.stderr);

  // A video with NO audio stream.
  r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=10:duration=1",
    "-pix_fmt", "yuv420p", "-y", videoNoAudio,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg silent gen failed: " + r.stderr);
});

d("extractAudioPcm / hasAudioTrack (ffmpeg)", () => {
  it("detects an audio track in a tone file and a muxed A/V file", () => {
    expect(hasAudioTrack(toneWav)).toBe(true);
    expect(hasAudioTrack(videoWithAudio)).toBe(true);
  });

  it("reports no audio track for a video without one", () => {
    expect(hasAudioTrack(videoNoAudio)).toBe(false);
    expect(extractAudioPcm(videoNoAudio).pcm.length).toBe(0);
  });

  it("decodes a 1s tone to ~sampleRate finite mono samples", () => {
    const { pcm, sampleRate } = extractAudioPcm(toneWav, { sampleRate: 22050 });
    expect(sampleRate).toBe(22050);
    // ~1 second → within 5% of sampleRate samples
    expect(pcm.length).toBeGreaterThan(0.95 * 22050);
    expect(pcm.length).toBeLessThan(1.1 * 22050);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      expect(Number.isFinite(pcm[i]!)).toBe(true);
      const a = Math.abs(pcm[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.1); // a real tone, not silence
    expect(peak).toBeLessThanOrEqual(1.5);
  });

  it("extracts the audio track out of a muxed A/V container", () => {
    const { pcm } = extractAudioPcm(videoWithAudio, { sampleRate: 22050 });
    expect(pcm.length).toBeGreaterThan(0.5 * 22050);
  });
});

if (ff) {
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
