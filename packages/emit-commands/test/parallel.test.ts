import { describe, it, expect } from "vitest";
import { fillBatch, type PlacedCell } from "../src/fill";
import { fillBatchFrames, parallelMap } from "../src/parallel";

const table: Record<number, string> = { 1: "minecraft:c1", 2: "minecraft:c2", 255: "minecraft:air" };
const resolve = (id: number) => table[id] ?? "minecraft:air";

function frame(y: number, ids: number[]): PlacedCell[] {
  return ids.map((mapColorId, x) => ({ x, y, z: 0, mapColorId }));
}

const frames: PlacedCell[][] = [
  frame(64, [1, 1, 1, 2, 2]),
  frame(64, [2, 2, 1, 1, 1]),
  frame(64, [1, 2, 1, 2, 1]),
  frame(64, new Array(20).fill(1)),
  frame(64, [2, 2, 2, 2]),
];

describe("parallel multi-core emission", () => {
  it("parallelMap is order-preserving and concurrency-invariant", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const expected = items.map((x) => x * 3);
    expect(await parallelMap(items, (x) => x * 3, 1)).toEqual(expected);
    expect(await parallelMap(items, (x) => x * 3, 8)).toEqual(expected);
  });

  it("fillBatchFrames across worker threads is byte-identical to serial", async () => {
    const serial = frames.map((cells) => fillBatch(cells, resolve));
    const parallel = await fillBatchFrames(frames, table, { concurrency: 4, parallel: true });
    expect(parallel).toEqual(serial);
  });

  it("serial fallback (parallel: false) matches too", async () => {
    const serial = frames.map((cells) => fillBatch(cells, resolve));
    expect(await fillBatchFrames(frames, table, { parallel: false })).toEqual(serial);
  });
});
