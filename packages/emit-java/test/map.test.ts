import { describe, it, expect } from "vitest";
import { getJavaMapPalette } from "@mineworld/palette";
import {
  preparePalette,
  quantizeFloydSteinberg,
  createRgbImage,
  setPixel,
  type RgbImage,
} from "@mineworld/color-core";
import { buildMapDat, readMapColors, toMapColors, splitIntoMaps, MAP_AREA } from "../src/map";
import { writeNbt, readNbt, Compound, Int, Str, Byte, ByteArray, TAG } from "../src/nbt";

const pal = preparePalette(getJavaMapPalette());

function gradient(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPixel(img, x, y, Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), 128);
    }
  }
  return img;
}

describe("NBT round-trip", () => {
  it("writes and reads a compound with mixed tag types", () => {
    const tree = Compound({
      DataVersion: Int(4435),
      name: Str("hello"),
      flag: Byte(1),
      blob: ByteArray(Uint8Array.from([0, 127, 200, 255])),
    });
    const { name, root } = readNbt(writeNbt("", tree));
    expect(name).toBe("");
    expect(root.type).toBe(TAG.Compound);
    if (root.type === TAG.Compound) {
      expect(root.value["name"]).toMatchObject({ type: TAG.String, value: "hello" });
      const blob = root.value["blob"];
      expect(blob?.type).toBe(TAG.ByteArray);
      if (blob?.type === TAG.ByteArray) expect([...blob.value]).toEqual([0, 127, 200, 255]);
    }
  });
});

describe("map.dat emitter", () => {
  it("round-trips a 128×128 quantized frame through gzipped map.dat", () => {
    const q = quantizeFloydSteinberg(gradient(128, 128), pal);
    const expected = toMapColors(q);
    expect(expected.length).toBe(MAP_AREA);

    const dat = buildMapDat(q); // gzipped
    expect(dat[0]).toBe(0x1f); // gzip magic
    expect(dat[1]).toBe(0x8b);

    const got = readMapColors(dat);
    expect(got.length).toBe(MAP_AREA);
    expect([...got]).toEqual([...expected]);
  });

  it("preserves color ids > 127 (signed-byte hazard) exactly", () => {
    // craft a frame whose ids include values above 127
    const q = quantizeFloydSteinberg(gradient(128, 128), pal);
    const hasHigh = [...q.mapColorId].some((v) => v > 127);
    expect(hasHigh).toBe(true);
    const got = readMapColors(buildMapDat(q, { gzip: false }));
    expect([...got]).toEqual([...q.mapColorId]);
  });

  it("rejects non-128 frames for a single map", () => {
    const q = quantizeFloydSteinberg(gradient(64, 64), pal);
    expect(() => toMapColors(q)).toThrow();
  });

  it("splits a 256×128 frame into a 2×1 map wall", () => {
    const q = quantizeFloydSteinberg(gradient(256, 128), pal);
    const tiles = splitIntoMaps(q);
    expect(tiles.length).toBe(2);
    expect(tiles.map((t) => [t.col, t.row])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    // tile (0,0) top-left pixel equals source top-left pixel
    expect(tiles[0]!.frame.mapColorId[0]).toBe(q.mapColorId[0]);
  });
});
