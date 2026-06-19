import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { voxelToLiveCommands, generateVoxelDatapack, greedyBoxes } from "../src/index";

// a tiny solid resolver: 7 → stone, 9 → oak_planks, else unmapped
const resolve = (id: number): string | undefined =>
  id === 7 ? "minecraft:stone" : id === 9 ? "minecraft:oak_planks" : undefined;

function build(): ReturnType<typeof createVolume> {
  const v = createVolume(4, 3, 2);
  setVoxel(v, 0, 0, 0, 7);
  setVoxel(v, 1, 0, 0, 7); // adjacent → greedy-merges with the first
  setVoxel(v, 3, 2, 1, 9);
  return v;
}

describe("voxelToLiveCommands (live 3D build over RCON)", () => {
  it("is byte-identical to the datapack's frame-0 keyframe (live == offline)", () => {
    const v = build();
    const origin = { x: 10, y: 64, z: -5 };
    const live = voxelToLiveCommands(v, origin, resolve);
    const pack = generateVoxelDatapack([v], resolve, { origin, optimize: (c, r) => greedyBoxes(c, r) });
    const f0 = [...pack.files.entries()].find(([k]) => k.endsWith("frames/0.mcfunction"));
    expect(f0).toBeDefined();
    const datapackCmds = f0![1].split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(live).toEqual(datapackCmds);
    expect(live.length).toBeGreaterThan(0);
  });

  it("places blocks at origin-offset world coords (2 adjacent stone → one /fill)", () => {
    const v = createVolume(2, 1, 1);
    setVoxel(v, 0, 0, 0, 7);
    setVoxel(v, 1, 0, 0, 7);
    const cmds = voxelToLiveCommands(v, { x: 100, y: 70, z: 20 }, resolve);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBe("fill 100 70 20 101 70 20 minecraft:stone replace");
  });

  it("an all-air volume yields no commands", () => {
    expect(voxelToLiveCommands(createVolume(3, 3, 3), { x: 0, y: 0, z: 0 }, resolve)).toEqual([]);
  });

  it("an unmapped solid id falls back (default air) without throwing", () => {
    const v = createVolume(1, 1, 1);
    setVoxel(v, 0, 0, 0, 42); // not in the resolver
    const cmds = voxelToLiveCommands(v, { x: 0, y: 0, z: 0 }, resolve, { fallbackBlock: "minecraft:cobblestone" });
    expect(cmds).toEqual(["setblock 0 0 0 minecraft:cobblestone replace"]);
  });
});
