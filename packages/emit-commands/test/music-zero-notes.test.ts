// Zero-note music honesty. The loop trim (loopTicksOverride = frames x speed) can empty
// the surviving note set entirely - e.g. every transcribed onset lands past a short
// animation loop. The sequencers report noteCount 0, but the emitters used to still write
// music.mcfunction and register <ns>:music in tick.json: #mt incremented forever against a
// never-created #mtcount, for a pack that plays nothing. Zero surviving notes must mean NO
// music machinery at all - byte-identical to a music-less build.

import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { generateVoxelDatapack } from "../src/datapack3d";
import {
  generateRgbScreenDatapack,
  generateRgbScreenDatapackReference,
  argbInt,
  type RgbScreenFrame,
} from "../src/rgbscreen";
import { describeMusicNotes, type RenderOptions } from "../../cli/src/render";

const resolve = (id: number) => `minecraft:c${id}`;

/** Every onset at tick >= 10: a 2-frame x speed-2 pack (4-tick loop) trims them ALL. */
const LATE_SONG: NoteEvent[] = Array.from({ length: 40 }, (_, i) => ({
  tick: 10 + i * 2,
  note: i % 25,
  instrument: "harp",
  velocity: 0.9,
}));

function volumes() {
  return [0, 1].map((f) => {
    const v = createVolume(3, 2, 1);
    setVoxel(v, f, 0, 0, 1);
    setVoxel(v, f + 1, 1, 0, 2);
    return v;
  });
}

function screenFrames(): RgbScreenFrame[] {
  const W = 4, H = 3;
  return [0, 1].map((f) => {
    const argb = new Int32Array(W * H);
    for (let i = 0; i < argb.length; i++) argb[i] = argbInt((f * 90 + i * 3) & 0xff, 40, 200);
    return { width: W, height: H, argb };
  });
}

function expectNoMusicMachinery(pack: { files: Map<string, string>; namespace: string; musicNoteCount?: number; musicLoopTicks?: number }): void {
  const fnDir = `data/${pack.namespace}/function`;
  expect(pack.files.has(`${fnDir}/music.mcfunction`)).toBe(false);
  const tick = JSON.parse(pack.files.get("data/minecraft/tags/function/tick.json")!);
  expect(tick.values).toEqual([`${pack.namespace}:driver`]); // no <ns>:music registration
  const setup = pack.files.get(`${fnDir}/setup.mcfunction`)!;
  expect(setup).not.toContain("#mt "); // no orphan music clock
  expect(setup).not.toContain("#mtcount");
  expect(pack.musicNoteCount).toBe(0);
  expect(pack.musicLoopTicks).toBe(0);
}

function expectFilesIdentical(a: Map<string, string>, b: Map<string, string>): void {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [k, v] of a) expect(b.get(k), k).toBe(v);
}

describe("voxel datapack: all notes trimmed by the loop = no music machinery", () => {
  for (const musicEngine of ["playsound", "redstone"] as const) {
    it(`${musicEngine}: emits no music.mcfunction / tick entry / #mt scores; byte-identical to a music-less pack`, () => {
      const pack = generateVoxelDatapack(volumes(), resolve, { music: LATE_SONG, musicEngine, speedTicks: 2 });
      expectNoMusicMachinery(pack);
      const noMusic = generateVoxelDatapack(volumes(), resolve, { speedTicks: 2 });
      expectFilesIdentical(pack.files, noMusic.files);
    });
  }
});

describe("rgbscreen datapack: all notes trimmed by the loop = no music machinery", () => {
  it("emits no music.mcfunction / tick entry / #mt scores; byte-identical to a music-less pack", () => {
    const pack = generateRgbScreenDatapack(screenFrames(), { music: LATE_SONG, speedTicks: 2 });
    expectNoMusicMachinery(pack);
    const noMusic = generateRgbScreenDatapack(screenFrames(), { speedTicks: 2 });
    expectFilesIdentical(pack.files, noMusic.files);
  });

  it("the verbatim reference emitter agrees byte-for-byte (opt-vs-ref contract holds for the zero-note case)", () => {
    const opt = generateRgbScreenDatapack(screenFrames(), { music: LATE_SONG, speedTicks: 2 });
    const ref = generateRgbScreenDatapackReference(screenFrames(), { music: LATE_SONG, speedTicks: 2 });
    expectFilesIdentical(opt.files, ref.files);
  });
});

describe("CLI note text (describeMusicNotes) for the zero-note pack", () => {
  const opts = { input: "in.mp4", out: "out", target: "voxel3d", width: 8, height: 8 } as RenderOptions;

  it("states the pack plays no music and names the REAL animation loop, not a 0-tick loop", () => {
    // the emitter reports 0/0 for a fully-trimmed melody; the real loop is frames x speed = 4
    const s = describeMusicNotes(LATE_SONG, { musicNoteCount: 0, musicLoopTicks: 0 }, opts, 4);
    expect(s).toContain("plays no music");
    expect(s).toContain(`none of the ${LATE_SONG.length} transcribed notes`);
    expect(s).toContain("the 4-tick animation loop");
    expect(s).not.toContain("0-tick");
  });

  it("keeps the honest trimmed-count text when some notes survive", () => {
    const s = describeMusicNotes(LATE_SONG, { musicNoteCount: 2, musicLoopTicks: 14 }, opts, 14);
    expect(s).toContain("2 notes from the audio track");
    expect(s).toContain("trimmed to the 14-tick animation loop: 2 of 40 notes");
  });
});
