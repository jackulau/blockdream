import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { render } from "../src/render";
import { runCli } from "../src/cli";

// End-to-end: a video WITH an audio track → render(voxel3d) emits a note-block music
// area + a playsound sequencer alongside the 3D build; a video WITHOUT audio (or
// --music off) emits no music. Proves D1+D2+D3 compose through the CLI.

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let avClip: string; // video + 440 Hz audio
let silentClip: string; // video, no audio

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-music-cli-"));
  avClip = join(dir, "av.mp4");
  silentClip = join(dir, "silent.mp4");

  let r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-pix_fmt", "yuv420p", "-y", avClip,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg av gen failed: " + r.stderr);

  r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=1",
    "-pix_fmt", "yuv420p", "-y", silentClip,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg silent gen failed: " + r.stderr);
});

function musicPath(out: string): string {
  return join(out, "data", "blockdream_3d", "function", "music.mcfunction");
}
function setupText(out: string): string {
  return readFileSync(join(out, "data", "blockdream_3d", "function", "setup.mcfunction"), "utf8");
}

d("render(voxel3d) + note-block music", () => {
  it("--music on emits a note-block music area and a playsound sequencer", () => {
    const out = join(dir, "on");
    const res = render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
    expect(res.notes.some((n) => /note-block music: \d+ notes/.test(n))).toBe(true);
    expect(existsSync(musicPath(out))).toBe(true);
    const music = readFileSync(musicPath(out), "utf8");
    expect(music).toContain("playsound minecraft:block.note_block.harp");
    expect(setupText(out)).toContain("minecraft:note_block[note=");
    expect(setupText(out)).toContain("#mtcount ma");
  });

  it("--music auto includes music when the video has an audio track", () => {
    const out = join(dir, "auto-av");
    render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "auto" });
    expect(existsSync(musicPath(out))).toBe(true);
  });

  it("--music auto adds NO music to an audio-less video", () => {
    const out = join(dir, "auto-silent");
    render({ input: silentClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "auto" });
    expect(existsSync(musicPath(out))).toBe(false);
    expect(setupText(out)).not.toContain("note_block");
  });

  it("--music off suppresses music even when the video has audio", () => {
    const out = join(dir, "off");
    render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "off" });
    expect(existsSync(musicPath(out))).toBe(false);
  });

  it("honours a custom --instrument", () => {
    const out = join(dir, "bell");
    render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on", musicInstrument: "bell" });
    expect(readFileSync(musicPath(out), "utf8")).toContain("playsound minecraft:block.note_block.bell");
  });
});

d("CLI flag plumbing", () => {
  it("runCli render --music on --instrument harp returns 0 and writes music", () => {
    const out = join(dir, "cli-on");
    const code = runCli(["render", avClip, "--target", "voxel3d", "--grid", "24x24", "--max-frames", "3", "--depth", "6", "--music", "on", "--instrument", "harp", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(musicPath(out))).toBe(true);
  });

  it("rejects an unknown --instrument", () => {
    const code = runCli(["render", avClip, "--target", "voxel3d", "--music", "on", "--instrument", "kazoo", "--out", join(dir, "bad")]);
    expect(code).toBe(2);
  });

  it("rejects an unknown --music mode", () => {
    const code = runCli(["render", avClip, "--target", "voxel3d", "--music", "loud", "--out", join(dir, "bad2")]);
    expect(code).toBe(2);
  });
});
