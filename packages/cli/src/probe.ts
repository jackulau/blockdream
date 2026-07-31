// Source frame-rate probe for the DEFAULT --fps path. extractFrames omits the fps filter when
// opts.fps is unset, so the decode keeps EVERY source frame - render needs the source's own rate
// to know whether the >20 fps honesty resample applies (a 60 fps source used to fall back to the
// speed-2 default = a 6x-slow pack, silently). ffprobe ships beside ffmpeg; every failure path
// returns undefined so callers FAIL OPEN (keep the plain decode) rather than guess.

import { spawnSync } from "node:child_process";

/** ffprobe binary: env BLOCKDREAM_FFPROBE; else beside a BLOCKDREAM_FFMPEG override (the two ship
 *  together); else "ffprobe" on PATH. Mirrors @blockdream/video's ffmpegBin(). */
export function ffprobeBin(): string {
  const probe = process.env["BLOCKDREAM_FFPROBE"];
  if (probe) return probe;
  const ff = process.env["BLOCKDREAM_FFMPEG"];
  // "/opt/bin/ffmpeg-7" → "/opt/bin/ffprobe-7" (rewrite only the basename)
  if (ff && /ffmpeg[^/\\]*$/.test(ff)) return ff.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1");
  return "ffprobe";
}

export function hasFfprobe(): boolean {
  try {
    const r = spawnSync(ffprobeBin(), ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Average video frame rate of the input's first video stream, in fps. Returns undefined when it
 * cannot be determined (no ffprobe, no video stream, a "0/0" rate) - never throws.
 */
export function probeSourceFps(input: string): number | undefined {
  try {
    const r = spawnSync(
      ffprobeBin(),
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { encoding: "utf8" },
    );
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return undefined;
    // e.g. "30/1", "30000/1001" (29.97), or "0/0" for streams with no known rate
    const m = /^(\d+)(?:\/(\d+))?$/.exec(r.stdout.trim().split("\n")[0]!.trim());
    if (!m) return undefined;
    const num = Number(m[1]);
    const den = m[2] === undefined ? 1 : Number(m[2]);
    return num > 0 && den > 0 ? num / den : undefined;
  } catch {
    return undefined;
  }
}
