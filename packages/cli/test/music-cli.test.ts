import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, hasFfmpeg } from "@blockdream/video";
import { generateVoxelDatapack } from "@blockdream/emit-commands";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { render } from "../src/render";
import { runCli } from "../src/cli";

// goal 088 D3 capability probe: the honest note-count report consumes the generators' additive
// musicNoteCount/musicLoopTicks result fields (lane E). Until those land, the CLI note degrades
// to the old min(length, cap) arithmetic and the truncation-honesty test below is skipped.
const probeVol = createVolume(1, 1, 1);
setVoxel(probeVol, 0, 0, 0, 10);
const probePack = generateVoxelDatapack([probeVol], () => "minecraft:stone", {
  music: [{ tick: 0, note: 12, instrument: "harp", velocity: 1 }],
});
const emitterReportsNoteCount = (probePack as { musicNoteCount?: number }).musicNoteCount !== undefined;

// End-to-end: a video WITH an audio track → render(voxel3d) emits a note-block music
// area + a playsound sequencer alongside the 3D build; a video WITHOUT audio (or
// --music off) emits no music. Proves D1+D2+D3 compose through the CLI.

const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

let dir: string;
let avClip: string; // video + 440 Hz audio
let silentClip: string; // video, no audio
let stillImg: string; // a single still frame — no audio STREAM at all (distinct from an audio-less video)
let melodyClip: string; // video + STEPPED-pitch audio: onsets spread across the clip (0, 5, 10, 15 ticks)

beforeAll(() => {
  if (!ff) return;
  dir = mkdtempSync(join(tmpdir(), "mw-music-cli-"));
  avClip = join(dir, "av.mp4");
  silentClip = join(dir, "silent.mp4");
  stillImg = join(dir, "still.png");
  melodyClip = join(dir, "melody.mp4");

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

  r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=1:duration=1",
    "-frames:v", "1", "-y", stillImg,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg still gen failed: " + r.stderr);

  // pitch steps every 0.25 s (220 -> 330 -> 495 -> 742 Hz, distinct note-block notes), so
  // analyzeAudio emits onsets at ticks ~0/5/10/15 - a melody LONGER than a short animation loop
  r = runFfmpeg([
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=48x48:rate=8:duration=1",
    "-f", "lavfi", "-i", "aevalsrc=sin(2*PI*t*220*exp(0.405465*floor(t*4))):d=1",
    "-shortest", "-pix_fmt", "yuv420p", "-y", melodyClip,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg melody gen failed: " + r.stderr);
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

  it("rejects an EMPTY --instrument (else it emits a broken block.note_block. / instrument= datapack)", () => {
    const code = runCli(["render", avClip, "--target", "voxel3d", "--instrument", "", "--out", join(dir, "empty-instr")]);
    expect(code).toBe(2);
  });

  it("warns that --music is ignored on a non-voxel3d target (no silent no-op)", () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      errs.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    const out = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    runCli(["render", avClip, "--target", "datapack", "--grid", "16x16", "--max-frames", "2", "--music", "on", "--out", join(dir, "wrong-target")]);
    spy.mockRestore();
    out.mockRestore();
    expect(errs.join("")).toContain("apply only to --target voxel3d");
  });

  // --music on is a FORCE, not auto: when the input carries no audio it must degrade to no music
  // (an explicit contract in render.ts analyzeMusicForInput), NOT crash on the ffmpeg audio decode.
  // The existing coverage only exercises --music AUTO + silent; these lock the FORCE path, and a
  // still IMAGE (no audio STREAM) is a distinct input from an audio-less VIDEO container.
  it("--music on on a still image (no audio stream) degrades cleanly: exit 0, no music, no crash", () => {
    const out = join(dir, "force-still");
    const code = runCli(["render", stillImg, "--target", "voxel3d", "--grid", "24x24", "--music", "on", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(musicPath(out))).toBe(false);
    expect(setupText(out)).not.toContain("note_block");
  });

  it("--music on on a silent video degrades cleanly: no music emitted", () => {
    const out = join(dir, "force-silent");
    const res = render({ input: silentClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
    expect(existsSync(musicPath(out))).toBe(false);
    expect(setupText(out)).not.toContain("note_block");
    expect(res.notes.some((n) => /note-block music/.test(n))).toBe(false);
  });

  // A negative --music-origin designates the music area at common in-world coords (e.g. below y or
  // behind spawn). node's parseArgs rejects a dash-leading value as "ambiguous"; joinDashValues
  // rewrites `--flag -v` → `--flag=-v` to let it through. This is the coordinate-bug class that
  // recurred on --origin (goals 055/056) — lock it on the MUSIC path so a regression can't silently
  // return to mangling negative coords.
  it("accepts a negative --music-origin and stamps the negative coords into setup", () => {
    const out = join(dir, "neg-music-origin");
    const code = runCli(["render", avClip, "--target", "voxel3d", "--grid", "24x24", "--max-frames", "3", "--depth", "6", "--music", "on", "--music-origin", "-20,70,-30", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(musicPath(out))).toBe(true);
    const setup = setupText(out);
    // the music note blocks land at the negative origin (x=-20, y=70) — proves the negative value
    // reached the emitter verbatim instead of being rejected or zeroed.
    expect(setup).toContain("setblock -20 70");
    expect(setup).toContain("minecraft:note_block[note=");
  });
});

// goal 088 D3: the CLI note used to report min(music.length, cap) while the emitter trims the
// melody to the ANIMATION loop (frames x speedTicks; repro: reported 150, emitted 2). The
// headline number must be the EMITTED count, with an explicit trimmed-to-loop note.
d("music note-count honesty (truncation to the animation loop)", () => {
  it.runIf(emitterReportsNoteCount)(
    "reports the ACTUAL emitted count and names the loop trim",
    () => {
      const out = join(dir, "trim");
      // 3 frames x default speed 2 = a 6-tick loop; the melody spans ~15 ticks -> notes trimmed
      const res = render({ input: melodyClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
      const musicFn = readFileSync(musicPath(out), "utf8");
      const emitted = (musicFn.match(/ run playsound /g) ?? []).length;
      expect(emitted).toBeGreaterThan(0);
      const note = res.notes.find((n) => /note-block music:/.test(n))!;
      const m = /note-block music: (\d+) notes/.exec(note)!;
      expect(Number(m[1])).toBe(emitted); // headline = what the pack actually plays
      const trim = /trimmed to the (\d+)-tick animation loop: (\d+) of (\d+) notes/.exec(note)!;
      expect(trim).not.toBeNull();
      expect(Number(trim[1])).toBe(6); // 3 frames x speed 2
      expect(Number(trim[2])).toBe(emitted);
      expect(Number(trim[3])).toBeGreaterThan(emitted); // some notes really were dropped
    },
  );

  it("a melody that FITS the loop reports its full count with no trim note", () => {
    const out = join(dir, "no-trim");
    // single-onset 440 Hz clip: 1 note at tick 0, well inside any loop
    const res = render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
    const musicFn = readFileSync(musicPath(out), "utf8");
    const emitted = (musicFn.match(/ run playsound /g) ?? []).length;
    const note = res.notes.find((n) => /note-block music:/.test(n))!;
    expect(note).toContain(`note-block music: ${emitted} notes`);
    expect(note).not.toContain("trimmed to");
  });
});

// --music-engine playsound|redstone: the same transcribed melody, two ways to make sound.
// playsound (default) = decorative keyboard + a /playsound clock. redstone = a physical
// repeater delay-line that powers the note blocks themselves. The default MUST stay
// byte-identical to a build with no --music-engine set.
d("redstone music engine (--music-engine)", () => {
  it("default engine stays playsound — no redstone leaks into the pack", () => {
    const out = join(dir, "engine-default");
    render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
    const music = readFileSync(musicPath(out), "utf8");
    expect(music).toContain("playsound minecraft:block.note_block");
    expect(music).not.toContain("redstone_block");
    expect(setupText(out)).not.toContain("minecraft:repeater");
  });

  it("--music-engine playsound is byte-identical to the default", () => {
    const a = join(dir, "engine-explicit-ps");
    const b = join(dir, "engine-default-ps");
    render({ input: avClip, out: a, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on", musicEngine: "playsound" });
    render({ input: avClip, out: b, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on" });
    expect(readFileSync(musicPath(a), "utf8")).toBe(readFileSync(musicPath(b), "utf8"));
    expect(setupText(a)).toBe(setupText(b));
  });

  it("--music-engine redstone builds a physical repeater delay-line that plays the note blocks", () => {
    const out = join(dir, "engine-redstone");
    const res = render({ input: avClip, out, target: "voxel3d", width: 24, height: 24, maxFrames: 3, depth: 6, music: "on", musicEngine: "redstone" });
    // melody is physical: the music function carries NO playsound, only the re-pulse metronome
    const music = readFileSync(musicPath(out), "utf8");
    expect(music).not.toContain("playsound");
    expect(music).toContain("minecraft:redstone_block");
    // the physical track lives in setup: a smooth_stone spine carrying redstone dust
    // with tuned note blocks beside it (this 1-note clip has no inter-note gap, so no
    // repeater — the repeater delay-line is covered by redstone-sequencer.test.ts's
    // multi-note fixture; here we prove the engine is WIRED end-to-end through the CLI).
    const setup = setupText(out);
    expect(setup).toContain("minecraft:smooth_stone"); // track floor — absent in playsound mode
    expect(setup).toContain("minecraft:redstone_wire"); // the timing spine
    expect(setup).toContain("minecraft:note_block[note=");
    expect(res.notes.some((n) => /redstone delay-line/.test(n))).toBe(true);
  });

  it("runCli --music-engine redstone returns 0 and writes the redstone track", () => {
    const out = join(dir, "cli-redstone");
    const code = runCli(["render", avClip, "--target", "voxel3d", "--grid", "24x24", "--max-frames", "3", "--depth", "6", "--music", "on", "--music-engine", "redstone", "--out", out]);
    expect(code).toBe(0);
    expect(setupText(out)).toContain("minecraft:redstone_wire");
  });

  it("rejects an unknown --music-engine", () => {
    const code = runCli(["render", avClip, "--target", "voxel3d", "--music", "on", "--music-engine", "pistons", "--out", join(dir, "bad-engine")]);
    expect(code).toBe(2);
  });

  // Composition: redstone engine + a NEGATIVE --music-origin. The coordinate-bug class
  // (node parseArgs rejecting a dash-leading value) recurred on --origin/--music-origin
  // (goals 055/056); the existing negative-origin lock only exercises the default playsound
  // engine. Prove the redstone delay-line also builds at common negative in-world coords.
  it("builds the redstone track at a NEGATIVE --music-origin", () => {
    const out = join(dir, "redstone-neg-origin");
    const code = runCli(["render", avClip, "--target", "voxel3d", "--grid", "24x24", "--max-frames", "3", "--depth", "6", "--music", "on", "--music-engine", "redstone", "--music-origin", "-20,70,-30", "--out", out]);
    expect(code).toBe(0);
    const setup = setupText(out);
    // the redstone input/spine lands at the negative origin (input at x-1 = -21), proving the
    // negative coords reached the redstone emitter verbatim — not rejected, not zeroed.
    expect(setup).toContain("setblock -21 70 -30 minecraft:air"); // pulse input cell
    expect(setup).toContain("minecraft:redstone_wire");
    expect(setup).toContain("minecraft:note_block[note=");
  });
});
