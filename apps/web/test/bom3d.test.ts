// Pure-aggregation tests for the 3D bill-of-materials helper (DOM-free by design), plus the
// regression net for the Int32Array-tally optimization: volumeBom must produce IDENTICAL output
// (deep-equal, floats included) to the retained verbatim Map-tally reference, and beat it in a
// same-run interleaved A/B (modest floor so a busy box cannot flake the gate).
import { describe, it, expect } from "vitest";
import { createVolume, setVoxel, EMPTY, type VoxelVolume } from "@blockdream/voxel";
import { volumeBom, volumeBomReference } from "../src/bom3d";

describe("volumeBom", () => {
  it("counts solid voxels per id, sorted by count desc, EMPTY excluded", () => {
    const v = createVolume(3, 3, 1); // 9 cells, all EMPTY initially
    setVoxel(v, 0, 0, 0, 10);
    setVoxel(v, 1, 0, 0, 10);
    setVoxel(v, 2, 0, 0, 10);
    setVoxel(v, 0, 1, 0, 42);
    setVoxel(v, 1, 1, 0, 42);
    setVoxel(v, 0, 2, 0, 7);
    const rows = volumeBom(v);
    expect(rows.map((r) => r.id)).toEqual([10, 42, 7]);
    expect(rows.map((r) => r.count)).toEqual([3, 2, 1]);
    expect(rows[0]!.pct).toBeCloseTo(50, 5); // 3 of 6 solid
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 5);
  });

  it("ties break by id ascending and an empty volume yields no rows", () => {
    const v = createVolume(2, 1, 1);
    expect(volumeBom(v)).toEqual([]);
    setVoxel(v, 0, 0, 0, 9);
    setVoxel(v, 1, 0, 0, 3);
    expect(volumeBom(v).map((r) => r.id)).toEqual([3, 9]);
  });
});

describe("volumeBom optimized tally vs retained reference", () => {
  /** Deterministic LCG so every volume is irregular but reproducible. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
  }

  /** ~solidPct% solid noise over the full 0..254 id range (255 = EMPTY stays air). */
  function randomVolume(n: number, seed: number, solidPct: number): VoxelVolume {
    const v = createVolume(n, n, n);
    const rand = lcg(seed);
    for (let i = 0; i < v.data.length; i++) {
      if (rand() % 100 >= solidPct) continue;
      v.data[i] = rand() % 255; // 0..254, never the EMPTY sentinel
    }
    return v;
  }

  it("is deep-equal to the reference (ids, counts, exact pct floats, row order) on random volumes", () => {
    const cases: Array<[string, VoxelVolume]> = [
      ["empty 8^3", createVolume(8, 8, 8)],
      ["sparse 16^3 (10% solid)", randomVolume(16, 0xa5eed, 10)],
      ["dense 32^3 (85% solid, full id spread)", randomVolume(32, 0xbead, 85)],
      ["noise 48^3 (45% solid)", randomVolume(48, 0xc0ffee, 45)],
    ];
    // all-ties volume: every id appears exactly once -> the comparator's id tiebreak orders ALL rows
    const ties = createVolume(255, 1, 1);
    for (let i = 0; i < 255; i++) ties.data[i] = i;
    cases.push(["255 distinct ids, one voxel each (pure tiebreak)", ties]);

    for (const [name, v] of cases) {
      const opt = volumeBom(v);
      const ref = volumeBomReference(v);
      expect(opt, name).toEqual(ref); // deep-equal: id, count, and pct float bits per row, in order
      expect(v.data.some((c) => c !== EMPTY) ? opt.length : 0, `${name}: row count sanity`).toBe(ref.length);
    }
  });

  it("optimized volumeBom is faster than the reference (same-run interleaved A/B)", { timeout: 60000, retry: 2 }, () => {
    const v = randomVolume(64, 0xd1ce, 55); // 262k cells, BOM-panel-sized workload
    // warmup (JIT) + identity re-check on the exact perf workload
    expect(volumeBom(v)).toEqual(volumeBomReference(v));

    // min-of-rounds per side: a spike only ever makes a round slower, never faster
    let refMs = Infinity;
    let optMs = Infinity;
    for (let round = 0; round < 9; round++) {
      let t = performance.now();
      volumeBomReference(v);
      refMs = Math.min(refMs, performance.now() - t);
      t = performance.now();
      volumeBom(v);
      optMs = Math.min(optMs, performance.now() - t);
    }
    const speedup = refMs / optMs;
    console.log(
      `volumeBom A/B (min of 9 rounds, 64^3 55% solid): reference ${refMs.toFixed(2)} ms, ` +
        `optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(2)}x`,
    );
    // modest floor well below the locally measured speedup: regression-guards without CI flake
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.3);
  });
});
