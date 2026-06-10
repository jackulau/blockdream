import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes } from "@blockdream/emit-commands";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { zipDatapack, loadInstructions } from "../src/datapack-export";
import { resolveBlock } from "../src/resolve-block";

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
