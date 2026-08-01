import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { computeVoxelDeltas, generateVoxelDatapack } from "../src/datapack3d";
import { fillBatch } from "../src/fill";
import { validatePack } from "../src/validate";

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
    expect(setup).not.toContain("minecraft:air"); // the box clear moved into frames/0 (wrap-safe)
    const f0 = pack.files.get("data/blockdream/function/frames/0.mcfunction")!;
    expect(f0).toContain("fill 0 64 0 2 64 0 minecraft:air replace"); // clears the build box every wrap
    // clear BEFORE paint (same tick, no flicker)
    expect(f0.indexOf("minecraft:air")).toBeLessThan(f0.indexOf("minecraft:c1"));
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

  it("reconstructs x/y/z across multiple planes (flat-walk index math, keyframe + delta)", () => {
    // 2x2x2 so y and z are both non-trivial — guards the i→(x,y,z) reconstruction
    const v0 = createVolume(2, 2, 2);
    setVoxel(v0, 0, 1, 0, 4); // backing index 2
    setVoxel(v0, 1, 1, 1, 7); // backing index 7
    // emitted in ascending backing-index (z→y→x) order
    expect(computeVoxelDeltas([v0])[0]!.cells).toEqual([
      { x: 0, y: 1, z: 0, mapColorId: 4 },
      { x: 1, y: 1, z: 1, mapColorId: 7 },
    ]);
    const v1 = createVolume(2, 2, 2);
    setVoxel(v1, 1, 1, 1, 9); // recolor the far corner; (0,1,0) drops to air
    expect(computeVoxelDeltas([v0, v1])[1]!.cells).toEqual([
      { x: 0, y: 1, z: 0, mapColorId: 255 }, // solid→air (EMPTY)
      { x: 1, y: 1, z: 1, mapColorId: 9 }, // recolor
    ]);
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

  it("optimize callback receives origin-offset cells with mapColorId preserved (explicit-build invariant)", () => {
    // The optimize branch builds each cell explicitly ({x,y,z,mapColorId}) instead of object-spread
    // for speed; this guards that the offset coords AND the mapColorId still arrive intact (a botched
    // spread-removal would silently drop mapColorId → every fill resolves to the fallback block).
    let captured: Array<{ x: number; y: number; z: number; mapColorId: number }> = [];
    generateVoxelDatapack([lineVolume()], resolve, {
      origin: { x: 10, y: 70, z: -5 },
      optimize: (cells, r) => {
        captured = cells.map((c) => ({ ...c }));
        return fillBatch(cells, r);
      },
    });
    // lineVolume: (0,0,0)=1, (1,0,0)=1, (2,0,0)=2 — offset by origin (10,70,-5)
    expect(captured).toEqual([
      { x: 10, y: 70, z: -5, mapColorId: 1 },
      { x: 11, y: 70, z: -5, mapColorId: 1 },
      { x: 12, y: 70, z: -5, mapColorId: 2 },
    ]);
    // each cell has EXACTLY the four fields (no stray spread leftovers, none missing)
    for (const c of captured) expect(Object.keys(c).sort()).toEqual(["mapColorId", "x", "y", "z"]);
  });
});

describe("generateVoxelDatapack pack validation", () => {
  it("every command in a 3D voxel pack is valid, incl. music, LED plane, and the redstone engine", () => {
    const v2 = createVolume(3, 1, 1);
    setVoxel(v2, 0, 0, 0, 2);
    const music = [
      { tick: 0, note: 12, instrument: "harp", velocity: 1 },
      { tick: 3, note: 15, instrument: "bell", velocity: 0.4 },
    ];
    const cases = [
      { origin: { x: 0, y: 64, z: 0 } },
      { music, ledPlane: "south" as const, autoplay: true },
      { music, musicEngine: "redstone" as const },
    ];
    for (const opts of cases) {
      const pack = generateVoxelDatapack([lineVolume(), v2], resolve, opts);
      const res = validatePack(pack.files);
      expect(res.ok, JSON.stringify(res.errors.slice(0, 5))).toBe(true);
    }
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
