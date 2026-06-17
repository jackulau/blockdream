import { describe, it, expect, afterEach } from "vitest";
import { extractFrames, runFfmpeg, ffmpegMissingMessage } from "../src/index";

// When ffmpeg isn't installed (the #1 video-input failure), the user must get an actionable error —
// not a raw "spawnSync ffmpeg ENOENT". Forcing BLOCKDREAM_FFMPEG at a path that doesn't exist
// simulates "no ffmpeg" deterministically, regardless of whether the CI box has ffmpeg.

const BOGUS = "/definitely/not/a/real/ffmpeg-binary-blockdream";
const saved = process.env["BLOCKDREAM_FFMPEG"];

afterEach(() => {
  if (saved === undefined) delete process.env["BLOCKDREAM_FFMPEG"];
  else process.env["BLOCKDREAM_FFMPEG"] = saved;
});

describe("ffmpeg missing → actionable error", () => {
  it("the message names the binary, an install path, and the env override", () => {
    process.env["BLOCKDREAM_FFMPEG"] = BOGUS;
    const msg = ffmpegMissingMessage();
    expect(msg).toMatch(/ffmpeg not found/i);
    expect(msg).toContain(BOGUS);
    expect(msg).toMatch(/install/i);
    expect(msg).toContain("BLOCKDREAM_FFMPEG");
  });

  it("runFfmpeg throws the friendly message (not a raw ENOENT) when the binary is absent", () => {
    process.env["BLOCKDREAM_FFMPEG"] = BOGUS;
    expect(() => runFfmpeg(["-version"])).toThrow(/ffmpeg not found/i);
  });

  it("extractFrames surfaces the friendly message too", () => {
    process.env["BLOCKDREAM_FFMPEG"] = BOGUS;
    expect(() => extractFrames("whatever.mp4", { width: 16, height: 16 })).toThrow(/install/i);
  });
});
