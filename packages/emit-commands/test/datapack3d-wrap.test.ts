// Loop-wrap correctness for the 3D voxel datapack. The driver wraps #f to 0 and re-runs
// frames/0, but the air-clear used to live only in setup: a voxel solid in the LAST frame
// and air in frame 0 was never cleared again, so a looping animation degraded to the
// union of all poses after the first pass. The clear now leads frames/0, so every wrap
// re-clears the box before repainting frame 0 in the same tick.

import { describe, it, expect } from "vitest";
import { createVolume, setVoxel } from "@blockdream/voxel";
import { generateVoxelDatapack } from "../src/datapack3d";
import { greedyBoxes } from "../src/fill";
import { runFunction, at, type Grid } from "./sim";

const resolve = (id: number) => `minecraft:c${id}`;
const origin = { x: 4, y: 64, z: -2 };

/** 2-frame sequence: voxel A=(2,1,0) is solid ONLY in frame 1 (air in frame 0). */
function frames() {
  const f0 = createVolume(3, 2, 1);
  setVoxel(f0, 0, 0, 0, 1);
  setVoxel(f0, 1, 1, 0, 2);
  const f1 = createVolume(3, 2, 1);
  setVoxel(f1, 0, 0, 0, 1);
  setVoxel(f1, 1, 1, 0, 2);
  setVoxel(f1, 2, 1, 0, 3); // voxel A: appears in frame 1 only
  return [f0, f1];
}

const A = at(origin.x + 2, origin.y + 1, origin.z); // voxel A's world cell

function frame0State(grid: Grid): void {
  // exactly frame 0: two solids, voxel A (and every other box cell) air
  expect(grid.get(at(origin.x, origin.y, origin.z))).toBe("minecraft:c1");
  expect(grid.get(at(origin.x + 1, origin.y + 1, origin.z))).toBe("minecraft:c2");
  expect(grid.get(A)).toBe("minecraft:air");
}

describe("voxel3d loop wrap re-clears the build box", () => {
  for (const [name, opts] of [
    ["setblock path", {}],
    ["optimize (greedyBoxes) path", { optimize: (c: Parameters<typeof greedyBoxes>[0], r: (id: number) => string) => greedyBoxes(c, r) }],
  ] as const) {
    it(`frames/0 clears wrap-stale voxels and a full wrap cycle lands on exactly frame-0 state (${name})`, () => {
      const pack = generateVoxelDatapack(frames(), resolve, { origin, ...opts });
      const files = pack.files;

      // frames/0 leads with an air fill that COVERS voxel A (the box clear), before any paint
      const f0 = files.get("data/blockdream/function/frames/0.mcfunction")!;
      const cmds = f0.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
      expect(cmds[0]).toBe(`fill ${origin.x} ${origin.y} ${origin.z} ${origin.x + 2} ${origin.y + 1} ${origin.z} minecraft:air replace`);
      const clearOnly: Grid = new Map();
      runFunction(new Map([["data/blockdream/function/frames/0.mcfunction", cmds[0]!]]), "blockdream:frames/0", "java", clearOnly);
      expect(clearOnly.get(A)).toBe("minecraft:air");
      // and setup no longer carries the clear (it calls frames/0, which does)
      const setup = files.get("data/blockdream/function/setup.mcfunction")!;
      expect(setup).not.toContain("minecraft:air");
      expect(setup).toContain("function blockdream:frames/0");

      // simulate a whole playback cycle THROUGH the wrap: setup → f1 → f0 (wrap)
      const grid: Grid = new Map();
      runFunction(files, "blockdream:setup", "java", grid); // includes frames/0 first pass
      frame0State(grid); // first pass renders frame 0 correctly (clear then paint)
      runFunction(files, "blockdream:frames/1", "java", grid);
      expect(grid.get(A)).toBe(resolve(3)); // frame 1 placed voxel A
      runFunction(files, "blockdream:frames/0", "java", grid); // the WRAP
      frame0State(grid); // voxel A cleared again - not the union of poses
    });
  }
});
