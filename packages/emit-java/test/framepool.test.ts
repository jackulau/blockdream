import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import { preparePalette, quantizeNearest, createRgbImage, setPixel, type RgbImage } from "@mineworld/color-core";
import { buildFramePool } from "../src/framepool";
import { MAP_AREA } from "../src/map";

const pal = preparePalette(getJavaMapPalette());

function solid(w: number, h: number, r: number, g: number, b: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, r, g, b);
  return img;
}

describe("frame pool (Fabric mod input)", () => {
  it("emits MWMW binary with correct header + size for a 2×1 map wall", () => {
    const frames = [
      quantizeNearest(solid(256, 128, 200, 30, 30), pal),
      quantizeNearest(solid(256, 128, 30, 200, 30), pal),
    ];
    const pool = buildFramePool(frames, 3);
    expect(pool.cols).toBe(2);
    expect(pool.rows).toBe(1);
    expect(pool.frameCount).toBe(2);

    // header
    expect(pool.bin.toString("ascii", 0, 4)).toBe("MWMW");
    expect(pool.bin.readInt32BE(4)).toBe(1); // version
    expect(pool.bin.readInt32BE(8)).toBe(2); // cols
    expect(pool.bin.readInt32BE(12)).toBe(1); // rows
    expect(pool.bin.readInt32BE(16)).toBe(2); // frames
    expect(pool.bin.readInt32BE(20)).toBe(3); // speed

    // size = header(24) + frames*tiles*16384
    const expected = 24 + 2 * (2 * 1) * MAP_AREA;
    expect(pool.bin.length).toBe(expected);
    expect(pool.mapsTxtTemplate).toContain("1 2");
  });

  it("rejects non-128-multiple frames", () => {
    expect(() => buildFramePool([quantizeNearest(solid(100, 100, 0, 0, 0), pal)])).toThrow();
  });
});
