// Import a real VIDEO file (.mp4/.webm/.mov/…) → per-frame canvases, decoded natively in the browser
// with a <video> element + canvas (NO ffmpeg, NO wasm - the browser already ships a video decoder).
// Returns the SAME { canvases, durationsMs } shape as gif.ts so it slots straight into the existing
// "frames → animated 3D blocks" path (rgbFramesToAnimated3d). The browser-only seek loop is thin and
// feature-detected; the sampling MATH (which timestamps to grab) is the pure, unit-tested
// planFrameTimes - jsdom can't decode video, exactly like gif.ts keeps its timing math in anim.ts.

export interface DecodedVideo {
  canvases: HTMLCanvasElement[];
  durationsMs: Array<number | undefined>;
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i;

/** True for files we should route through the native video decoder (by MIME or extension). */
export function isVideoFile(file: { type?: string; name?: string }): boolean {
  if (file.type && file.type.startsWith("video/")) return true;
  return !!file.name && VIDEO_EXT.test(file.name);
}

export interface VideoSampleOptions {
  /** frames/sec to sample (default 12 - smooth enough for block playback, cheap to decode). */
  fps?: number;
  /** hard cap on sampled frames (default 48). Long clips are sampled evenly across the whole duration. */
  maxFrames?: number;
  /** downscale decoded frames to this width (aspect kept). Essential for LONG clips: thousands of
   *  full-resolution canvases would exhaust memory; the block grid needs far fewer pixels anyway. */
  targetWidth?: number;
  /** decode progress callback (framesDone, framesTotal) - a whole-video decode takes a while. */
  onProgress?: (done: number, total: number) => void;
  /** STREAMING mode: called with each decoded frame as it lands. When set, frames are NOT
   *  accumulated (the returned `canvases` is empty) - the only way a whole video at real fps
   *  fits in memory. The canvas passed in is reused-safe: consume it synchronously. */
  onFrame?: (canvas: HTMLCanvasElement, index: number, total: number) => void;
}

/**
 * Plan which timestamps (seconds) to grab from a clip of `durationSec`. Pure + deterministic so it
 * can be unit-tested without a browser. Guarantees: always ≥1 time, first is 0, times are strictly
 * ascending, none land exactly on `durationSec` (a seek to the very end often never fires `seeked`),
 * and the count never exceeds maxFrames.
 */
export function planFrameTimes(durationSec: number, opts: VideoSampleOptions = {}): number[] {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 12;
  const maxFrames = opts.maxFrames && opts.maxFrames > 0 ? Math.floor(opts.maxFrames) : 48;
  // Non-finite / non-positive duration (some streams report this before metadata) → a single frame.
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  // Keep the last sample just inside the clip so the final `seeked` actually fires.
  const end = Math.max(0, durationSec - Math.min(1 / 120, durationSec / 2));
  const byFps = Math.floor(durationSec * fps) + 1; // how many frames the fps would yield
  const n = Math.max(1, Math.min(byFps, maxFrames));
  if (n === 1) return [0];
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push((end * i) / (n - 1));
  return times;
}

/** Per-frame display durations (ms) from the planned sample times (gap to the next sample). */
function durationsFromTimes(times: number[], durationSec: number): Array<number | undefined> {
  return times.map((t, i) => {
    const next = i + 1 < times.length ? times[i + 1]! : durationSec;
    const ms = (next - t) * 1000;
    return ms > 0 ? ms : undefined;
  });
}

/** Resolve when the <video> has seeked to (or near) `t`, with a timeout fallback so a decoder that
 *  never re-fires `seeked` (e.g. seeking to a time it's already at) can't hang the import. */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    video.currentTime = t;
    setTimeout(finish, 2000);
  });
}

/**
 * Decode a video File into per-frame canvases at the requested sampling. Browser-only (needs a real
 * <video> decoder); throws a clear error where that isn't available (jsdom, headless without codecs).
 */
export async function decodeVideo(file: File, opts: VideoSampleOptions = {}): Promise<DecodedVideo> {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
    throw new Error("video decode needs a browser <video> element (not available here)");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(`cannot decode ${file.name || "video"} in this browser`)), { once: true });
    });
    const duration = video.duration;
    const srcW = video.videoWidth || 64;
    const srcH = video.videoHeight || 64;
    const w = opts.targetWidth && opts.targetWidth > 0 ? Math.min(srcW, Math.floor(opts.targetWidth)) : srcW;
    const h = Math.max(1, Math.round((w * srcH) / srcW));
    const times = planFrameTimes(duration, opts);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < times.length; i++) {
      await seekTo(video, times[i]!);
      ctx.drawImage(video, 0, 0, w, h);
      if (opts.onFrame) {
        // STREAMING: hand the shared draw canvas to the consumer and do NOT accumulate a copy.
        // A whole video at real fps is thousands of frames - copies would exhaust memory; the
        // consumer quantizes to its compact per-frame form synchronously and drops the pixels.
        opts.onFrame(canvas, i, times.length);
      } else {
        const frame = document.createElement("canvas");
        frame.width = w;
        frame.height = h;
        frame.getContext("2d")!.drawImage(canvas, 0, 0);
        canvases.push(frame);
      }
      opts.onProgress?.(i + 1, times.length);
    }
    return { canvases, durationsMs: durationsFromTimes(times, duration) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
