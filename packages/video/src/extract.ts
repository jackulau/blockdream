import type { RgbImage } from "@blockdream/color-core";
import { runFfmpeg } from "./ffmpeg";

export interface ExtractOptions {
  /** target frame width (the block-grid width). Required for raw parsing. */
  width: number;
  /** target frame height (the block-grid height). Required for raw parsing. */
  height: number;
  /** sample rate in frames/sec. Default: source rate (omit fps filter). */
  fps?: number;
  /**
   * ffmpeg scale filter flags. "area" = box average (good for downscaling).
   * Note: ffmpeg scales in gamma space; use resizeAreaLinear for linear-light
   * quality from a larger decode. Default "area".
   */
  scaleFlags?: string;
  /** cap the number of frames returned (decoded with -frames:v). */
  maxFrames?: number;
}

/**
 * Decode a GIF/video file into an array of tightly-packed RGB frames at the
 * requested grid size, using ffmpeg. Frame size is forced to width×height so the
 * raw rgb24 stream can be sliced deterministically.
 */
export function extractFrames(input: string, opts: ExtractOptions): RgbImage[] {
  const { width, height } = opts;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("width/height must be > 0");
  const flags = opts.scaleFlags ?? "area";
  const vf: string[] = [];
  if (opts.fps && opts.fps > 0) vf.push(`fps=${opts.fps}`);
  vf.push(`scale=${width}:${height}:flags=${flags}`);

  const args = ["-v", "error", "-i", input, "-vf", vf.join(",")];
  if (opts.maxFrames && opts.maxFrames > 0) args.push("-frames:v", String(opts.maxFrames));
  args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "-");

  const { stdout, status, stderr } = runFfmpeg(args);
  if (status !== 0) throw new Error(`ffmpeg failed (status ${status}): ${stderr.slice(0, 500)}`);

  const frameSize = width * height * 3;
  if (frameSize === 0 || stdout.length % frameSize !== 0) {
    throw new Error(`unexpected rawvideo length ${stdout.length} for frame size ${frameSize}`);
  }
  const count = stdout.length / frameSize;
  const frames: RgbImage[] = [];
  for (let i = 0; i < count; i++) {
    const data = new Uint8Array(frameSize);
    stdout.copy(data, 0, i * frameSize, (i + 1) * frameSize);
    frames.push({ width, height, data });
  }
  return frames;
}
