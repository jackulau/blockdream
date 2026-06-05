import { spawnSync } from "node:child_process";

/** ffmpeg binary: override with env MINEWORLD_FFMPEG, else "ffmpeg" on PATH. */
export function ffmpegBin(): string {
  return process.env["MINEWORLD_FFMPEG"] || "ffmpeg";
}

export function hasFfmpeg(): boolean {
  try {
    const r = spawnSync(ffmpegBin(), ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface FfmpegResult {
  stdout: Buffer;
  stderr: string;
  status: number | null;
}

/** Run ffmpeg with the given args; stdout is captured as binary. */
export function runFfmpeg(args: string[], maxBuffer = 1 << 30): FfmpegResult {
  const r = spawnSync(ffmpegBin(), args, { maxBuffer });
  if (r.error) throw r.error;
  return {
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ? r.stderr.toString("utf8") : "",
    status: r.status,
  };
}
