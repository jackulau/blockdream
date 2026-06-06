import { describe, it, expect } from "vitest";
import { fillBatch, fillBatchCount, type PlacedCell } from "../src/fill";

const resolve = (id: number) => (id === 255 ? "minecraft:air" : `minecraft:c${id}`);

function row(y: number, z: number, ids: number[], x0 = 0): PlacedCell[] {
  return ids.map((mapColorId, i) => ({ x: x0 + i, y, z, mapColorId }));
}

describe("fillBatch (/fill run-batching)", () => {
  it("collapses a solid run into a single /fill (huge reduction)", () => {
    const cells = row(64, 0, new Array(64).fill(3)); // 64 same-block cells
    const lines = fillBatch(cells, resolve);
    expect(lines).toEqual(["fill 0 64 0 63 64 0 minecraft:c3 replace"]); // 64 → 1 command
    expect(fillBatchCount(cells, resolve)).toBe(1);
  });

  it("splits at block changes and keeps singletons as /setblock", () => {
    const cells = row(64, 0, [1, 1, 1, 2, 3]); // run of 3× c1, then c2, c3
    expect(fillBatch(cells, resolve)).toEqual([
      "fill 0 64 0 2 64 0 minecraft:c1 replace",
      "setblock 3 64 0 minecraft:c2 replace",
      "setblock 4 64 0 minecraft:c3 replace",
    ]);
  });

  it("breaks runs across an X gap (non-contiguous cells)", () => {
    const cells = [...row(64, 0, [5, 5]), ...row(64, 0, [5, 5], 10)]; // x 0-1 and x 10-11
    const lines = fillBatch(cells, resolve);
    expect(lines).toEqual([
      "fill 0 64 0 1 64 0 minecraft:c5 replace",
      "fill 10 64 0 11 64 0 minecraft:c5 replace",
    ]);
  });

  it("works in 3D (independent runs per (y,z) row) and beats per-cell setblock", () => {
    const cells = [...row(64, 0, new Array(8).fill(1)), ...row(65, 2, new Array(8).fill(1))];
    const lines = fillBatch(cells, resolve);
    expect(lines.length).toBe(2); // two rows → two fills
    expect(lines.length).toBeLessThan(cells.length); // 2 << 16 setblocks
  });
});
