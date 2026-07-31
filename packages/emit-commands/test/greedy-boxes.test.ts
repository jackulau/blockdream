import { describe, it, expect } from "vitest";
import { greedyBoxes, greedyBoxesSparse, type PlacedCell } from "../src/index";

const resolve = (id: number): string => "minecraft:b" + (id % 5);

function wall(): PlacedCell[] {
  const c: PlacedCell[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) c.push({ x, y, z: 5, mapColorId: (x + y) % 3 });
  return c;
}
function solidNeg(): PlacedCell[] {
  const c: PlacedCell[] = [];
  for (let z = -2; z < 3; z++) for (let y = 0; y < 4; y++) for (let x = -1; x < 3; x++) c.push({ x, y, z, mapColorId: 2 });
  return c;
}
function block(w: number, h: number, d: number, color: (x: number, y: number, z: number) => number): PlacedCell[] {
  const c: PlacedCell[] = [];
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c.push({ x, y, z, mapColorId: color(x, y, z) });
  return c;
}

describe("greedyBoxes (typed-array grid optimization)", () => {
  const cases: [string, PlacedCell[]][] = [
    ["empty", []],
    ["single cell", [{ x: 3, y: 4, z: 5, mapColorId: 1 }]],
    ["2D wall, multi-block", wall()],
    ["3D solid, negative coords", solidNeg()],
    ["mixed runs + singletons", [{ x: 0, y: 0, z: 0, mapColorId: 1 }, { x: 1, y: 0, z: 0, mapColorId: 1 }, { x: 5, y: 5, z: 5, mapColorId: 2 }]],
    ["uniform solid over the /fill cap (fillLines split)", block(40, 40, 40, () => 3)], // 64000 > 32768 → splits
    ["checkerboard (many tiny boxes)", block(12, 12, 4, (x, y, z) => (x + y + z) % 2)],
    // resolve is id%5, so ids 1/6/11 (and 2/7) are DISTINCT map-colour ids resolving to the SAME
    // block string: the per-call mapColorId memo must give them ONE palette id (string-Map dedup
    // preserved) or boxes would stop merging across them.
    ["distinct ids, same resolved block", block(10, 6, 3, (x, y) => (y % 2 === 0 ? [1, 2][x % 2]! : [6, 7, 11][x % 3]!))],
    // ids outside the byte memo (300, -4, 2.5) must skip it and still match the reference.
    ["non-byte map-colour ids (memo bypass)", block(8, 4, 2, (x, y, z) => [300, -4, 2.5, 1][(x + y + z) % 4]!)],
  ];

  for (const [name, cells] of cases) {
    it(`byte-identical to the string-key reference: ${name}`, () => {
      expect(greedyBoxes(cells, resolve)).toEqual(greedyBoxesSparse(cells, resolve));
    });
  }

  it("merges a run of DISTINCT map-colour ids that resolve to the same block into one fill", () => {
    // ids 1 and 6 both resolve to minecraft:b1; if the memo broke the string-Map dedup they would
    // get different palette ids and this row would emit two commands instead of one fill.
    const cells: PlacedCell[] = [1, 6, 1, 6, 1, 6].map((id, x) => ({ x, y: 0, z: 0, mapColorId: id }));
    const out = greedyBoxes(cells, resolve);
    expect(out).toEqual(["fill 0 0 0 5 0 0 minecraft:b1 replace"]);
    expect(out).toEqual(greedyBoxesSparse(cells, resolve));
  });

  it("calls resolve once per distinct byte map-colour id, not once per cell", () => {
    let calls = 0;
    const counting = (id: number): string => {
      calls++;
      return "minecraft:b" + (id % 5);
    };
    greedyBoxes(block(16, 16, 4, (x, y, z) => (x + y + z) % 7), counting); // 1024 cells, 7 distinct ids
    expect(calls).toBe(7);
  });

  it("falls back correctly when the bounding box exceeds the dense-grid cap", () => {
    // two cells 4000 apart → a 4001³ bounding box ≫ GREEDY_GRID_CAP → must use the string-key path
    const cells: PlacedCell[] = [{ x: 0, y: 0, z: 0, mapColorId: 1 }, { x: 4000, y: 4000, z: 4000, mapColorId: 2 }];
    const out = greedyBoxes(cells, resolve);
    expect(out).toEqual(greedyBoxesSparse(cells, resolve));
    expect(out).toHaveLength(2); // two distant setblocks, not a giant fill
  });

  it("greedyBoxesSparse fails loud above the JS Map limit instead of a cryptic 'Map maximum size exceeded'", () => {
    // a length-only fake: the guard reads .length and throws before touching any cell (no 16M alloc)
    const tooBig = { length: 16_000_001 } as unknown as PlacedCell[];
    expect(() => greedyBoxesSparse(tooBig, resolve)).toThrow(/build too large/);
  });

  it("is byte-identical AND faster than the string-key reference on a large multi-box build", () => {
    const cells = block(128, 128, 4, (x, y, z) => (x * 3 + y * 5 + z) % 6); // ~65k cells, many boxes
    const t0 = performance.now();
    const opt = greedyBoxes(cells, resolve);
    const optMs = performance.now() - t0;
    const t1 = performance.now();
    const ref = greedyBoxesSparse(cells, resolve);
    const refMs = performance.now() - t1;
    expect(opt).toEqual(ref); // the optimization changes nothing but speed
    expect(optMs).toBeLessThan(refMs); // typed-array grid beats string keys (manually ~100× at 512px)
  }, 20000);
});
