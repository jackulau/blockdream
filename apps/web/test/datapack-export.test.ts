import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { generateJavaDatapack } from "@mineworld/emit-commands";
import { zipDatapack } from "../src/datapack-export";

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
});
