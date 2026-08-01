import { describe, it, expect } from "vitest";
import {
  argbInt,
  generateRgbScreenDatapack,
  pixelPos,
  type RgbScreenFrame,
  type ScreenFacing,
} from "../src/rgbscreen";

// Regression for the north/east forceload degeneration: pixelPos mirrors the
// along-axis for north (x = origin.x + (width - along)) and east, so bounding the
// rect over {origin, pixel W-1} alone collapsed it to a single chunk (repro: a
// 64x8 north screen emitted `forceload add 0 0 0 0` while its pixels span x 0..63).
// The rect must cover the CHUNKS of every pixel position for all four facings.

const W = 64;
const H = 8;
const ORIGIN = { x: 0, y: 64, z: 0 };
const FACINGS: ScreenFacing[] = ["north", "south", "east", "west"];

function makeFrames(): RgbScreenFrame[] {
  const n = W * H;
  const a = new Int32Array(n);
  const b = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = argbInt(i & 0xff, (i >> 8) & 0xff, 7);
    b[i] = argbInt((i + 3) & 0xff, 9, 200);
  }
  return [
    { width: W, height: H, argb: a },
    { width: W, height: H, argb: b },
  ];
}

/** Parse `forceload add x0 z0 x1 z1` out of a function body. */
function parseForceload(body: string): { x0: number; z0: number; x1: number; z1: number } {
  const m = body.match(/^forceload add (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/m);
  expect(m, `no forceload add line in:\n${body}`).toBeTruthy();
  const [, x0, z0, x1, z1] = m!;
  return { x0: Number(x0), z0: Number(z0), x1: Number(x1), z1: Number(z1) };
}

const chunkOf = (block: number) => Math.floor(block / 16);

describe("rgbscreen forceload covers the screen for every facing", () => {
  for (const facing of FACINGS) {
    it(`${facing}: the forceload rect covers the chunk of every pixel position`, () => {
      const pack = generateRgbScreenDatapack(makeFrames(), { origin: ORIGIN, facing });
      const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
      const fl = parseForceload(setup);
      // expected span from the corner pixels (pixelPos is the emitter's own mapping)
      const c0 = pixelPos(ORIGIN, facing, W, H, 0, 0);
      const c1 = pixelPos(ORIGIN, facing, W, H, W - 1, 0);
      const ex0 = Math.min(Math.floor(c0.x), Math.floor(c1.x));
      const ex1 = Math.max(Math.floor(c0.x), Math.floor(c1.x));
      const ez0 = Math.min(Math.floor(c0.z), Math.floor(c1.z));
      const ez1 = Math.max(Math.floor(c0.z), Math.floor(c1.z));
      expect(fl.x0).toBeLessThanOrEqual(ex0);
      expect(fl.x1).toBeGreaterThanOrEqual(ex1);
      expect(fl.z0).toBeLessThanOrEqual(ez0);
      expect(fl.z1).toBeGreaterThanOrEqual(ez1);
      // and every single pixel's chunk lies inside the forceloaded chunk span
      // (forceload add loads all chunks between its two BLOCK positions)
      for (let iy = 0; iy < H; iy++) {
        for (let ix = 0; ix < W; ix++) {
          const p = pixelPos(ORIGIN, facing, W, H, ix, iy);
          const cx = chunkOf(Math.floor(p.x));
          const cz = chunkOf(Math.floor(p.z));
          expect(cx).toBeGreaterThanOrEqual(chunkOf(fl.x0));
          expect(cx).toBeLessThanOrEqual(chunkOf(fl.x1));
          expect(cz).toBeGreaterThanOrEqual(chunkOf(fl.z0));
          expect(cz).toBeLessThanOrEqual(chunkOf(fl.z1));
        }
      }
      // the rect is not the degenerate single-chunk repro shape
      const spanChunks =
        (chunkOf(fl.x1) - chunkOf(fl.x0) + 1) * (chunkOf(fl.z1) - chunkOf(fl.z0) + 1);
      expect(spanChunks).toBeGreaterThanOrEqual(4); // 64px along = 4 chunks minimum
    });
  }

  it("north: the default musicOrigin lands OUTSIDE the screen footprint", () => {
    const music = [
      { tick: 0, note: 12, instrument: "harp", velocity: 1 },
      { tick: 2, note: 15, instrument: "bell", velocity: 0.8 },
    ];
    const pack = generateRgbScreenDatapack(makeFrames(), { origin: ORIGIN, facing: "north", music });
    const setup = pack.files.get(`data/${pack.namespace}/function/setup.mcfunction`)!;
    // screen footprint on the (x, z) plane: the block under every pixel position
    const footprint = new Set<string>();
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const p = pixelPos(ORIGIN, "north", W, H, ix, iy);
        footprint.add(`${Math.floor(p.x)},${Math.floor(p.z)}`);
      }
    }
    // the physical keyboard (the only setblocks in an rgbscreen setup) must not
    // overlap the screen columns (the screen spans the full y range there)
    const keyboard = setup.split("\n").filter((l) => l.startsWith("setblock "));
    expect(keyboard.length).toBeGreaterThan(0);
    for (const line of keyboard) {
      const [, x, , z] = line.split(" ");
      expect(footprint.has(`${Number(x)},${Number(z)}`), `keyboard block inside screen: ${line}`).toBe(false);
    }
    // and the playsound source sits off-screen too
    const musicFn = pack.files.get(`data/${pack.namespace}/function/music.mcfunction`)!;
    const ps = musicFn.match(/playsound \S+ \S+ @a (-?\d+) (-?\d+) (-?\d+)/);
    expect(ps).toBeTruthy();
    expect(footprint.has(`${Number(ps![1])},${Number(ps![3])}`)).toBe(false);
  });
});
