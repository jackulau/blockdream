import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { computeVoxelDeltas, generateVoxelDatapack } from "../src/datapack3d";
import { fillBatch } from "../src/fill";

const resolve = (id: number) => `minecraft:c${id}`;

function lineVolume() {
  const v = createVolume(3, 1, 1);
  setVoxel(v, 0, 0, 0, 1);
  setVoxel(v, 1, 0, 0, 1);
  setVoxel(v, 2, 0, 0, 2);
  return v;
}

describe("generateVoxelDatapack (3D)", () => {
  it("builds a vanilla datapack with a cleared box, 3D setblocks, and the tick driver", () => {
    const pack = generateVoxelDatapack([lineVolume()], resolve, { origin: { x: 0, y: 64, z: 0 } });
    const setup = pack.files.get("data/blockdream/function/setup.mcfunction")!;
    expect(setup).toContain("forceload add 0 0 2 0");
    expect(setup).toContain("fill 0 64 0 2 64 0 minecraft:air replace"); // clears the build box
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    expect(f0).toContain("setblock 0 64 0 minecraft:c1 replace");
    expect(f0).toContain("setblock 2 64 0 minecraft:c2 replace");
    expect(pack.files.get("data/minecraft/tags/function/tick.json")).toContain("blockdream:driver");
    expect(pack.files.get("data/blockdream/function/play.mcfunction")).toContain("$function blockdream:frames/$(idx)");
    expect(JSON.parse(pack.files.get("pack.mcmeta")!).pack.pack_format).toBe(48);
    expect(pack.totalSetblocks).toBe(3);
  });

  it("delta-encodes animation frames, incl. solid→air transitions", () => {
    const v0 = lineVolume();
    const v1 = createVolume(3, 1, 1);
    setVoxel(v1, 0, 0, 0, 1);
    setVoxel(v1, 1, 0, 0, 1); // (2,0,0) became air
    const deltas = computeVoxelDeltas([v0, v1]);
    expect(deltas[0]!.keyframe).toBe(true);
    expect(deltas[0]!.cells.length).toBe(3);
    expect(deltas[1]!.cells).toEqual([{ x: 2, y: 0, z: 0, mapColorId: 255 }]); // EMPTY
    const pack = generateVoxelDatapack([v0, v1], resolve);
    expect(pack.files.get("data/blockdream/function/frames/1.mcfunction")).toContain("setblock 2 64 0 minecraft:air replace");
  });

  it("optimize hook (fill run-batching) collapses contiguous same-block runs", () => {
    const pack = generateVoxelDatapack([lineVolume()], resolve, {
      origin: { x: 0, y: 64, z: 0 },
      optimize: (cells, r) => fillBatch(cells, r),
    });
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    expect(f0).toContain("fill 0 64 0 1 64 0 minecraft:c1 replace"); // the two c1 cells → one /fill
    expect(f0).toContain("setblock 2 64 0 minecraft:c2 replace"); // singleton stays /setblock
  });
});

describe("start/stop chunk lifecycle (3D)", () => {
  it("stop releases the forceloaded chunks and start re-acquires them", () => {
    const pack = generateVoxelDatapack([lineVolume()], resolve, { origin: { x: 0, y: 64, z: 0 } });
    const start = pack.files.get("data/blockdream/function/start.mcfunction")!;
    const stop = pack.files.get("data/blockdream/function/stop.mcfunction")!;
    expect(start).toContain("forceload add 0 0 2 0");
    expect(start).toContain("scoreboard players set #play ma 1");
    expect(stop).toContain("forceload remove 0 0 2 0");
    expect(stop).toContain("scoreboard players set #play ma 0");
  });
});
