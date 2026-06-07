import { describe, it, expect } from "vitest";
import { getJavaMapPalette, getSolidBlockMapPalette } from "@blockdream/palette";
import {
  preparePalette,
  quantizeNearest,
  createRgbImage,
  setPixel,
  type RgbImage,
} from "@blockdream/color-core";
import { buildMcStructure, readMcStructure } from "../src/mcstructure";
import { writeNbt, readNbt, Compound, Int, Str, TAG } from "@blockdream/nbt";

function gradient(w: number, h: number): RgbImage {
  const img = createRgbImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      setPixel(img, x, y, Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), 90);
  return img;
}

describe("little-endian NBT", () => {
  it("round-trips an int through LE encoding (distinct from BE)", () => {
    const tree = Compound({ n: Int(0x01020304), tag: Str("x") });
    const le = writeNbt("", tree, "little");
    const be = writeNbt("", tree, "big");
    expect(Buffer.compare(le, be)).not.toBe(0); // byte order differs
    const back = readNbt(le, "little");
    if (back.root.type === TAG.Compound) {
      expect(back.root.value["n"]).toMatchObject({ type: TAG.Int, value: 0x01020304 });
    }
  });
});

describe("mcstructure emitter", () => {
  const { palette, blockByMapColorId } = getSolidBlockMapPalette();
  const solid = preparePalette(palette);

  it("emits a parseable wall sized W×H×1 with the right block palette", () => {
    const img = gradient(8, 6);
    const q = quantizeNearest(img, solid);
    const buf = buildMcStructure(q, (id) => {
      const b = blockByMapColorId.get(id);
      return b ? { name: b.id, states: {} } : undefined;
    });
    const parsed = readMcStructure(buf);
    expect(parsed.size).toEqual([8, 6, 1]);
    expect(parsed.indices.length).toBe(8 * 6 * 1);
    // every used block name should be a real namespaced id
    expect(parsed.blockNames.every((n) => n.startsWith("minecraft:"))).toBe(true);
    // at least one concrete/solid block placed (not all air)
    const nonAir = parsed.indices.filter((i) => parsed.blockNames[i] !== "minecraft:air");
    expect(nonAir.length).toBeGreaterThan(0);
  });

  it("places the correct block at a known solid-color pixel", () => {
    // fill with a color that matches white_concrete closely
    const img = createRgbImage(2, 2);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(img, x, y, 255, 255, 255);
    const q = quantizeNearest(img, solid);
    const buf = buildMcStructure(q, (id) => {
      const b = blockByMapColorId.get(id);
      return b ? { name: b.id, states: {} } : undefined;
    });
    const parsed = readMcStructure(buf);
    const placed = new Set(parsed.indices.map((i) => parsed.blockNames[i]));
    // white-ish region should resolve to a light solid block
    expect([...placed].some((n) => n!.includes("concrete") || n!.includes("wool") || n!.includes("quartz") || n!.includes("white"))).toBe(true);
  });
});
