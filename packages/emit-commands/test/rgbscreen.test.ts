import { describe, it, expect } from "vitest";
import type { RgbImage } from "@blockdream/color-core";
import {
  argbInt,
  generateRgbScreenDatapack,
  pixelUuid,
  rgbImageToScreenFrame,
  uuidString,
  type RgbScreenFrame,
} from "../src/rgbscreen";

function frameOf(width: number, height: number, px: Array<[number, number, number]>): RgbScreenFrame {
  const argb = new Int32Array(width * height);
  px.forEach(([r, g, b], i) => (argb[i] = argbInt(r, g, b)));
  return { width, height, argb };
}

describe("pixelUuid", () => {
  it("is deterministic and collision-free across a 64x48 screen", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64 * 48; i++) {
      const s = uuidString(pixelUuid("blockdream_rgb", i));
      expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(seen.has(s), `uuid collision at pixel ${i}`).toBe(false);
      seen.add(s);
    }
    // deterministic: same inputs → same uuid
    expect(uuidString(pixelUuid("blockdream_rgb", 7))).toBe(uuidString(pixelUuid("blockdream_rgb", 7)));
    // namespace-scoped: two screens never share entity ids
    expect(uuidString(pixelUuid("a", 0))).not.toBe(uuidString(pixelUuid("b", 0)));
  });
});

describe("argbInt / rgbImageToScreenFrame", () => {
  it("packs opaque ARGB as the signed int NBT wants", () => {
    expect(argbInt(0, 0, 0)).toBe(-16777216); // 0xff000000
    expect(argbInt(255, 255, 255)).toBe(-1); // 0xffffffff
    expect(argbInt(255, 0, 0)).toBe(-65536); // 0xffff0000
  });

  it("posterizes channels to the requested level count (and 0 = exact)", () => {
    const img: RgbImage = { width: 2, height: 1, data: new Uint8Array([10, 130, 250, 0, 128, 255]) };
    const two = rgbImageToScreenFrame(img, 2); // levels=2 → each channel snaps to 0 or 255
    expect(two.argb[0]).toBe(argbInt(0, 255, 255));
    expect(two.argb[1]).toBe(argbInt(0, 255, 255));
    const exact = rgbImageToScreenFrame(img, 0);
    expect(exact.argb[0]).toBe(argbInt(10, 130, 250));
  });
});

describe("generateRgbScreenDatapack", () => {
  const f0 = frameOf(2, 2, [
    [0, 0, 0],
    [255, 255, 255],
    [0, 0, 0],
    [255, 255, 255],
  ]);
  const f1 = frameOf(2, 2, [
    [255, 0, 0], // changed
    [255, 255, 255],
    [0, 0, 0],
    [0, 255, 0], // changed
  ]);

  it("summons one full-bright fixed-billboard pixel per cell with frame 0 baked in", () => {
    const pack = generateRgbScreenDatapack([f0, f1], { dataVersion: 4903 });
    const screen = pack.files.get("data/blockdream_rgb/function/screen.mcfunction")!;
    const summons = screen.split("\n").filter((l) => l.startsWith("summon"));
    expect(summons).toHaveLength(4);
    expect(summons[0]).toContain(`background:${argbInt(0, 0, 0)}`);
    expect(summons[1]).toContain(`background:${argbInt(255, 255, 255)}`);
    expect(summons[0]).toContain(`brightness:{sky:15,block:15}`);
    expect(summons[0]).toContain(`billboard:"fixed"`);
    expect(summons[0]).toContain(`Tags:["blockdream_rgb"]`);
    expect(summons[0]).toContain(`UUID:[I;`);
    // 1.21.5+ (SNBT component era) → plain string text
    expect(summons[0]).toContain(`text:" "`);
  });

  it("uses the JSON-in-string text component below DataVersion 4325 (pre-1.21.5)", () => {
    const pack = generateRgbScreenDatapack([f0], { dataVersion: 3955 });
    const screen = pack.files.get("data/blockdream_rgb/function/screen.mcfunction")!;
    expect(screen).toContain(`text:'{"text":" "}'`);
  });

  it("delta-encodes frames against the previous frame, addressing pixels by literal UUID", () => {
    const pack = generateRgbScreenDatapack([f0, f1], {});
    const fr1 = pack.files.get("data/blockdream_rgb/function/frames/1.mcfunction")!;
    const merges = fr1.split("\n").filter((l) => l.startsWith("data merge"));
    expect(merges).toHaveLength(2);
    expect(merges[0]).toBe(
      `data merge entity ${uuidString(pixelUuid("blockdream_rgb", 0))} {background:${argbInt(255, 0, 0)}}`,
    );
    expect(merges[1]).toBe(
      `data merge entity ${uuidString(pixelUuid("blockdream_rgb", 3))} {background:${argbInt(0, 255, 0)}}`,
    );
  });

  it("frame 0 is the WRAP delta (last → 0), so the loop re-enters cleanly", () => {
    const pack = generateRgbScreenDatapack([f0, f1], {});
    const fr0 = pack.files.get("data/blockdream_rgb/function/frames/0.mcfunction")!;
    const merges = fr0.split("\n").filter((l) => l.startsWith("data merge"));
    expect(merges).toHaveLength(2); // pixels 0 and 3 revert
    expect(merges[0]).toContain(`{background:${argbInt(0, 0, 0)}}`);
    // single-frame pack: nothing ever changes
    const still = generateRgbScreenDatapack([f0], {});
    const stillF0 = still.files.get("data/blockdream_rgb/function/frames/0.mcfunction")!;
    expect(stillF0.split("\n").filter((l) => l.startsWith("data merge"))).toHaveLength(0);
  });

  it("setup is idempotent (kill by tag first) and teardown fully removes the screen", () => {
    const pack = generateRgbScreenDatapack([f0], {});
    const setup = pack.files.get("data/blockdream_rgb/function/setup.mcfunction")!;
    expect(setup).toContain(`kill @e[type=minecraft:text_display,tag=blockdream_rgb]`);
    expect(setup).toContain(`function blockdream_rgb:screen`);
    const teardown = pack.files.get("data/blockdream_rgb/function/teardown.mcfunction")!;
    expect(teardown).toContain(`kill @e[type=minecraft:text_display,tag=blockdream_rgb]`);
    expect(teardown).toContain(`forceload remove`);
    // kill only reaches LOADED entities: teardown must forceload BEFORE killing, or a
    // teardown issued after the screen chunks unloaded (post-:stop) leaks pixel entities
    expect(teardown.indexOf("forceload add")).toBeGreaterThanOrEqual(0);
    expect(teardown.indexOf("forceload add")).toBeLessThan(teardown.indexOf("kill @e"));
  });

  it("mirrors X for a north-facing screen so the image reads un-flipped", () => {
    const south = generateRgbScreenDatapack([f0], { facing: "south" });
    const north = generateRgbScreenDatapack([f0], { facing: "north" });
    const sx = south.files.get("data/blockdream_rgb/function/screen.mcfunction")!.split("\n").filter((l) => l.startsWith("summon"));
    const nx = north.files.get("data/blockdream_rgb/function/screen.mcfunction")!.split("\n").filter((l) => l.startsWith("summon"));
    const xOf = (s: string) => Number(s.split(" ")[2]);
    expect(xOf(sx[0]!)).toBe(0.5);
    expect(xOf(sx[1]!)).toBe(1.5);
    expect(xOf(nx[0]!)).toBe(1.5); // mirrored
    expect(xOf(nx[1]!)).toBe(0.5);
    expect(nx[0]).toContain(`Rotation:[180f,0f]`);
  });

  it("music: shares the #play clock, joins the tick tag, and locks its loop to the animation", () => {
    const music = [
      { tick: 0, note: 12, instrument: "harp", velocity: 1 },
      { tick: 3, note: 14, instrument: "harp", velocity: 1 },
      { tick: 99, note: 10, instrument: "harp", velocity: 1 }, // beyond the loop → trimmed
    ];
    const pack = generateRgbScreenDatapack([f0, f1], { music, speedTicks: 2 });
    const tick = JSON.parse(pack.files.get("data/minecraft/tags/function/tick.json")!);
    expect(tick.values).toEqual(["blockdream_rgb:driver", "blockdream_rgb:music"]);
    const setup = pack.files.get("data/blockdream_rgb/function/setup.mcfunction")!;
    expect(setup).toContain(`scoreboard players set #mtcount ma 4`); // 2 frames × 2 ticks
    const musicFn = pack.files.get("data/blockdream_rgb/function/music.mcfunction")!;
    expect(musicFn).toContain(`matches 0 run playsound`);
    expect(musicFn).toContain(`matches 3 run playsound`);
    expect(musicFn).not.toContain(`matches 99`);
  });

  it("stamps pack_format + supported_formats and reports command totals", () => {
    const pack = generateRgbScreenDatapack([f0, f1], {
      packFormat: 107,
      supportedFormats: { min_inclusive: 48, max_inclusive: 107 },
    });
    const meta = JSON.parse(pack.files.get("pack.mcmeta")!);
    expect(meta.pack.pack_format).toBe(107);
    expect(meta.pack.supported_formats).toEqual({ min_inclusive: 48, max_inclusive: 107 });
    expect(pack.totalCommands).toBe(4); // 2 changed px × 2 delta frames (incl. wrap)
    expect(pack.frameCount).toBe(2);
  });

  it("splits an over-budget frame into parts", () => {
    const big0 = frameOf(20, 20, []);
    const big1 = { width: 20, height: 20, argb: new Int32Array(400).fill(argbInt(1, 2, 3)) };
    const pack = generateRgbScreenDatapack([big0, big1], { maxCommandsPerFunction: 100 });
    expect(pack.files.get("data/blockdream_rgb/function/frames/1.mcfunction")).toContain("frames/1/part0");
    expect(pack.files.has("data/blockdream_rgb/function/frames/1/part3.mcfunction")).toBe(true);
  });
});
