import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes } from "@blockdream/emit-commands";
import { createVolume, setVoxel } from "@blockdream/voxel";
import {
  zipDatapack,
  loadInstructions,
  planTickPlayback,
  planExportBudget,
  EXPORT_FRAME_BUDGET,
} from "../src/datapack-export";
import { resolveBlock } from "../src/resolve-block";
import { planDatapackPlacement, initialArrangeState, arrangeReducer } from "../src/canvas-mod";
import type { NoteEvent } from "@blockdream/audio";

const frame = {
  width: 2,
  height: 2,
  mapColorId: Uint8Array.from([1, 2, 3, 4]),
  paletteIndex: Int32Array.from([1, 2, 3, 4]),
};

describe("zipDatapack", () => {
  it("packages a generated datapack into a valid, unzippable .zip", () => {
    const pack = generateJavaDatapack([frame], (id) => `minecraft:c${id}`);
    const zip = zipDatapack(pack.files);
    expect(zip.byteLength).toBeGreaterThan(0);

    const files = unzipSync(zip);
    // a valid datapack: pack.mcmeta + a frame function + the tick tag
    expect(files["pack.mcmeta"]).toBeDefined();
    expect(strFromU8(files["pack.mcmeta"]!)).toContain("pack_format");
    expect(files["data/minecraft/tags/function/tick.json"]).toBeDefined();
    const frameKey = Object.keys(files).find((k) => /function\/frames\/0\.mcfunction$/.test(k))!;
    expect(frameKey).toBeTruthy();
    // content round-trips through the zip
    expect(strFromU8(files[frameKey]!)).toContain("setblock");
  });

  it("3D voxel export end-to-end: animated volume → datapack → zip → unzip → playable pack", () => {
    // a 2-frame animated volume through the SAME path the page's download button takes
    const a = createVolume(3, 2, 2);
    setVoxel(a, 0, 0, 0, 10);
    setVoxel(a, 1, 0, 0, 10);
    setVoxel(a, 2, 1, 1, 22);
    const b = createVolume(3, 2, 2);
    setVoxel(b, 0, 0, 0, 10);
    setVoxel(b, 1, 1, 0, 22); // moved + recolored
    const pack = generateVoxelDatapack([a, b], resolveBlock, {
      namespace: "blockdream_3d",
      supportedFormats: { min_inclusive: 48, max_inclusive: 88 },
      optimize: (cells, r) => greedyBoxes(cells, r),
    });
    const files = unzipSync(zipDatapack(pack.files));

    // playable structure: setup/start/stop + both frames under the blockdream_3d namespace
    for (const fn of ["setup", "start", "stop"]) {
      expect(files[`data/blockdream_3d/function/${fn}.mcfunction`], `${fn}.mcfunction`).toBeDefined();
    }
    expect(files["data/blockdream_3d/function/frames/0.mcfunction"]).toBeDefined();
    expect(files["data/blockdream_3d/function/frames/1.mcfunction"]).toBeDefined();
    expect(strFromU8(files["data/minecraft/tags/function/tick.json"]!)).toContain("blockdream_3d:driver");

    // cross-version pack.mcmeta
    const meta = JSON.parse(strFromU8(files["pack.mcmeta"]!));
    expect(meta.pack.supported_formats).toEqual({ min_inclusive: 48, max_inclusive: 88 });

    // every placed block is the SAFE resolver's output (no air-resolving ids in solid cells)
    const f0 = strFromU8(files["data/blockdream_3d/function/frames/0.mcfunction"]!);
    expect(f0).toContain(resolveBlock(10));
    expect(f0).toContain(resolveBlock(22));

    // bundled instructions are honest: fixed origin + clearing warning, no player-position myth
    const howTo = strFromU8(files["HOW_TO_LOAD.txt"]!);
    expect(howTo).toContain("blockdream_3d:setup");
    expect(howTo).toContain("FIXED origin");
    expect(howTo).toContain("CLEARS");
    expect(howTo).not.toContain("stand where you want");
    expect(loadInstructions(pack.files)).toContain("blockdream_3d:start");

    // stop releases chunks, start re-acquires (server-friendly pause)
    expect(strFromU8(files["data/blockdream_3d/function/stop.mcfunction"]!)).toContain("forceload remove");
    expect(strFromU8(files["data/blockdream_3d/function/start.mcfunction"]!)).toContain("forceload add");
  });
});

describe("canvas-mod export wiring (note-block music in the web download)", () => {
  const buildVolume = () => {
    const v = createVolume(3, 2, 2);
    setVoxel(v, 0, 0, 0, 10);
    setVoxel(v, 1, 0, 0, 10);
    setVoxel(v, 2, 1, 1, 22);
    return v;
  };
  const NOTES: NoteEvent[] = [
    { tick: 0, note: 12, instrument: "harp", velocity: 0.8 },
    { tick: 6, note: 19, instrument: "harp", velocity: 0.7 },
  ];
  const exportPack = (notes: NoteEvent[], arrange: ReturnType<typeof initialArrangeState>) => {
    const placement = planDatapackPlacement(notes, arrange, { x: 0, y: 64, z: 0 });
    return generateVoxelDatapack([buildVolume()], resolveBlock, {
      namespace: "blockdream_3d",
      supportedFormats: { min_inclusive: 48, max_inclusive: 88 },
      optimize: (cells, r) => greedyBoxes(cells, r),
      origin: placement.origin,
      music: placement.music,
      musicOrigin: placement.musicOrigin,
    });
  };

  it("includes a note-block music area + playsound sequencer when notes present AND toggle on", () => {
    const arrange = arrangeReducer(initialArrangeState(8), { type: "setShowMusic", show: true });
    const files = unzipSync(zipDatapack(exportPack(NOTES, arrange).files));
    expect(files["data/blockdream_3d/function/music.mcfunction"]).toBeDefined();
    const music = strFromU8(files["data/blockdream_3d/function/music.mcfunction"]!);
    expect(music).toContain("playsound minecraft:block.note_block.harp");
    const setup = strFromU8(files["data/blockdream_3d/function/setup.mcfunction"]!);
    expect(setup).toContain("minecraft:note_block[note=12,instrument=harp]");
    expect(strFromU8(files["data/minecraft/tags/function/tick.json"]!)).toContain("blockdream_3d:music");
  });

  it("toggle OFF ⇒ byte-identical to a music-less export (no note blocks at all)", () => {
    const off = arrangeReducer(initialArrangeState(8), { type: "setShowMusic", show: false });
    const withToggleOff = Object.fromEntries(exportPack(NOTES, off).files);
    const noNotes = Object.fromEntries(exportPack([], initialArrangeState(8)).files);
    expect(withToggleOff).toEqual(noNotes);
    expect(withToggleOff["data/blockdream_3d/function/music.mcfunction"]).toBeUndefined();
  });

  it("no notes ⇒ no music, regardless of the toggle", () => {
    const on = arrangeReducer(initialArrangeState(8), { type: "setShowMusic", show: true });
    const files = exportPack([], on).files;
    expect(files.has("data/blockdream_3d/function/music.mcfunction")).toBe(false);
  });

  it("places the music area at the DRAGGED music position (origin reflects the drag)", () => {
    // drag the music area to x=30, z=-7 → note blocks land at world x=30.., z=-7
    let arrange = initialArrangeState(8);
    arrange = arrangeReducer(arrange, { type: "move", id: "music", to: { x: 30, z: -7 } });
    const setup = strFromU8(
      unzipSync(zipDatapack(exportPack(NOTES, arrange).files))["data/blockdream_3d/function/setup.mcfunction"]!,
    );
    // a tuned note block sits on the dragged Z plane (z = base 0 + round(-7) = -7)
    expect(setup).toMatch(/setblock 3[0-9] 6[0-9] -7 minecraft:note_block/);
  });
});

describe("planTickPlayback (Minecraft's 20 fps / 1-frame-per-tick ceiling)", () => {
  it("no timing info keeps the legacy 2-ticks-per-frame default (baked spins/effects)", () => {
    const p = planTickPlayback(24, null);
    expect(p).toMatchObject({ speedTicks: 2, fps: 10, resampled: false });
    expect(p.indices).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("a 10 fps clip keeps every frame at 2 ticks (100 ms) dwell", () => {
    const p = planTickPlayback(50, Array.from({ length: 50 }, () => 100));
    expect(p).toMatchObject({ speedTicks: 2, fps: 10, resampled: false });
    expect(p.indices.length).toBe(50);
  });

  it("a 20 fps clip plays 1:1 - one frame per game tick, nothing skipped", () => {
    const p = planTickPlayback(100, Array.from({ length: 100 }, () => 50));
    expect(p).toMatchObject({ speedTicks: 1, fps: 20, resampled: false });
    expect(p.indices.length).toBe(100);
  });

  it("a 60 fps clip is resampled EVENLY to 20 fps with the SAME wall-clock duration", () => {
    const n = 600; // 10 s at 60 fps
    const p = planTickPlayback(n, Array.from({ length: n }, () => 1000 / 60));
    expect(p.resampled).toBe(true);
    expect(p.speedTicks).toBe(1);
    // 10 s at 1 frame/tick = 200 frames → in-game duration still 10 s
    expect(p.indices.length).toBe(200);
    // even coverage: strictly non-decreasing, first ~0, last near the end, ~every 3rd frame
    expect(p.indices[0]).toBe(0);
    expect(p.indices[p.indices.length - 1]!).toBeGreaterThan(n - 5);
    for (let i = 1; i < p.indices.length; i++) expect(p.indices[i]!).toBeGreaterThanOrEqual(p.indices[i - 1]!);
  });

  it("a 30 fps clip halves-ish to 20 fps (2/3 of frames), duration preserved", () => {
    const n = 300; // 10 s at 30 fps
    const p = planTickPlayback(n, Array.from({ length: n }, () => 1000 / 30));
    expect(p.resampled).toBe(true);
    expect(p.indices.length).toBe(200); // 10 s × 20 fps
  });

  it("single frame and unknown durations fall back safely", () => {
    expect(planTickPlayback(1, [40]).indices).toEqual([0]);
    const p = planTickPlayback(4, [undefined, undefined, undefined, undefined]);
    expect(p.resampled).toBe(false); // fallback 100 ms/frame = 10 fps
    expect(p.speedTicks).toBe(2);
  });
});

describe("planExportBudget (function-file export budget guard)", () => {
  it("the budget never drops below the largest real-server-validated pack (2191 frames, goal 083)", () => {
    expect(EXPORT_FRAME_BUDGET).toBeGreaterThanOrEqual(2191);
  });

  it("at or below the budget: warn=false, still reports the planned count", () => {
    for (const n of [1, 24, 2191, EXPORT_FRAME_BUDGET]) {
      const p = planExportBudget(n);
      expect(p.warn, `${n} frames`).toBe(false);
      expect(p.frameCount).toBe(n);
      expect(p.budget).toBe(EXPORT_FRAME_BUDGET);
      expect(p.message).toContain(String(n));
    }
  });

  it("2191 frames exactly (validated live, goal 083) is within budget - never warned about", () => {
    expect(planExportBudget(2191).warn).toBe(false);
  });

  it("above the budget: warn=true with the planned count and the budget in the message", () => {
    const over = EXPORT_FRAME_BUDGET + 1;
    const p = planExportBudget(over);
    expect(p.warn).toBe(true);
    expect(p.message).toContain(String(over));
    expect(p.message).toContain(String(EXPORT_FRAME_BUDGET));
  });

  it("a worst-case web decode (20 fps x 660 s = 13200 frames) is flagged, not blocked", () => {
    const p = planExportBudget(13200);
    expect(p.warn).toBe(true);
    expect(p.message).toContain("13200");
    // guard reports; it must not throw or cap - the caller decides how to surface it
    expect(p.frameCount).toBe(13200);
  });

  it("respects an explicit budget override (pure function, no hidden state)", () => {
    expect(planExportBudget(10, 10).warn).toBe(false);
    expect(planExportBudget(11, 10).warn).toBe(true);
  });
});

describe("loadInstructions origin (goal 088 D9g: the guide points where the pack builds)", () => {
  const files = new Map([["data/myns/function/setup.mcfunction", "# setup"]]);

  it("threads the pack's REAL origin into the bundled instructions", () => {
    const text = loadInstructions(files, { x: 40, y: 70, z: -12 });
    expect(text).toContain("around x=40 y=70 z=-12");
    expect(text).toContain("/tp 40 86 -12"); // teleport hovers 16 blocks above the origin
    expect(text).not.toContain("x=0 y=64 z=0");
  });

  it("defaults to the emitters' shared 0,64,0 origin when no origin is given", () => {
    const text = loadInstructions(files);
    expect(text).toContain("around x=0 y=64 z=0");
    expect(text).toContain("/tp 0 80 0");
  });

  it("zipDatapack carries the origin into the bundled HOW_TO_LOAD.txt", () => {
    const unzipped = unzipSync(zipDatapack(files, { x: 40, y: 70, z: -12 }));
    expect(strFromU8(unzipped["HOW_TO_LOAD.txt"]!)).toContain("/tp 40 86 -12");
  });
});
