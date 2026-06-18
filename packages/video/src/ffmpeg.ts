import { spawnSync } from "node:child_process";

/** ffmpeg binary: override with env BLOCKDREAM_FFMPEG, else "ffmpeg" on PATH. */
export function ffmpegBin(): string {
  return process.env["BLOCKDREAM_FFMPEG"] || "ffmpeg";
}

export function hasFfmpeg(): boolean {
  try {
    const r = spawnSync(ffmpegBin(), ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Actionable message for "ffmpeg isn't installed / on PATH" — decoding images & video needs it. */
export function ffmpegMissingMessage(): string {
  const bin = ffmpegBin();
  return (
    `ffmpeg not found (tried "${bin}"). Blockdream needs ffmpeg to decode images and video.\n` +
    `  install:  macOS  brew install ffmpeg   ·   Debian/Ubuntu  sudo apt-get install ffmpeg   ·   https://ffmpeg.org/download.html\n` +
    `  or point BLOCKDREAM_FFMPEG at an ffmpeg binary (e.g. BLOCKDREAM_FFMPEG=/path/to/ffmpeg).`
  );
}

export interface FfmpegResult {
  stdout: Buffer;
  stderr: string;
  status: number | null;
}

/** Run ffmpeg with the given args; stdout is captured as binary. Optional stdin input. */
export function runFfmpeg(args: string[], maxBuffer = 1 << 30, input?: Buffer): FfmpegResult {
  const r = spawnSync(ffmpegBin(), args, { maxBuffer, input });
  if (r.error) {
    // Missing binary (ENOENT) → a clear, actionable error instead of a raw "spawnSync ENOENT".
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(ffmpegMissingMessage());
    throw r.error;
  }
  return {
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ? r.stderr.toString("utf8") : "",
    status: r.status,
  };
}
