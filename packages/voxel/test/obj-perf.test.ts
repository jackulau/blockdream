// Locks the goal-088 D16 model-import optimizations (trisToVolume scratch scalars + hoists,
// solidify Int32Array stack + boundary-plane seeding) against their verbatim pre-optimization
// reference twins: byte-identity on adversarial meshes, then same-run interleaved A/B timing.

import { describe, it, expect } from "vitest";
import {
  trisToVolume,
  trisToVolumeReference,
  solidify,
  solidifyReference,
  type V3,
  type Tri,
  type RasterOptions,
} from "../src/obj";
import { createVolume, setVoxel, cloneVolume, countSolid, type VoxelVolume } from "../src/volume";

// deterministic PRNG (same generator the bench uses) so every run tests the same meshes
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMesh(seed: number, triCount: number, spread = 10): { verts: V3[]; tris: Tri[] } {
  const rnd = mulberry32(seed);
  const verts: V3[] = [];
  const tris: Tri[] = [];
  for (let t = 0; t < triCount; t++) {
    const base = verts.length;
    verts.push(
      [rnd() * spread, rnd() * spread, rnd() * spread],
      [rnd() * spread, rnd() * spread, rnd() * spread],
      [rnd() * spread, rnd() * spread, rnd() * spread],
    );
    tris.push([base, base + 1, base + 2]);
  }
  return { verts, tris };
}

// closed unit-cube shell mesh (12 tris) - watertight, so solid:true fills the interior
function cubeMesh(): { verts: V3[]; tris: Tri[] } {
  const verts: V3[] = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const quads: Array<[number, number, number, number]> = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5],
  ];
  const tris: Tri[] = [];
  for (const [a, b, c, d] of quads) tris.push([a, b, c], [a, c, d]);
  return { verts, tris };
}

function expectVolumesByteIdentical(opt: VoxelVolume, ref: VoxelVolume): void {
  expect([opt.sx, opt.sy, opt.sz]).toEqual([ref.sx, ref.sy, ref.sz]);
  expect(Buffer.compare(Buffer.from(opt.data), Buffer.from(ref.data))).toBe(0);
}

function expectRasterIdentical(verts: V3[], tris: Tri[], opts: RasterOptions = {}): void {
  expectVolumesByteIdentical(trisToVolume(verts, tris, opts), trisToVolumeReference(verts, tris, opts));
}

describe("trisToVolume is byte-identical to the verbatim reference", () => {
  it("degenerate triangles: zero-area (coincident verts) and collinear verts", () => {
    const verts: V3[] = [
      [2, 2, 2], [2, 2, 2], [2, 2, 2], // all coincident -> a single point
      [0, 0, 0], [3, 3, 3], [6, 6, 6], // collinear -> a line
      [0, 5, 0], [5, 5, 0], [2, 5, 4], // one honest triangle
    ];
    const tris: Tri[] = [[0, 1, 2], [3, 4, 5], [6, 7, 8]];
    for (const solid of [false, true]) expectRasterIdentical(verts, tris, { resolution: 16, solid });
  });

  it("out-of-bounds samples: shared bounds smaller than the mesh exercise the inlined bounds check", () => {
    const { verts, tris } = randomMesh(0xa11ce, 60, 10);
    // bounds cover only a slice of the mesh -> many samples land outside the res box on BOTH
    // sides (grid coords negative and >= res) and must be dropped identically
    const bounds = { min: [3, 3, 3] as V3, max: [7, 7, 7] as V3 };
    for (const solid of [false, true]) expectRasterIdentical(verts, tris, { resolution: 12, bounds, solid });
  });

  it("single-voxel mesh: a triangle far smaller than one cell", () => {
    const verts: V3[] = [[5, 5, 5], [5.001, 5, 5], [5, 5.001, 5]];
    const tris: Tri[] = [[0, 1, 2]];
    // own-bounds (extent ~0.001) AND a wide shared box (the tri collapses to one voxel)
    expectRasterIdentical(verts, tris, { resolution: 8 });
    expectRasterIdentical(verts, tris, { resolution: 8, bounds: { min: [0, 0, 0], max: [10, 10, 10] } });
  });

  it("thin shell: a large flat quad (2 tris spanning the whole box)", () => {
    const verts: V3[] = [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]];
    const tris: Tri[] = [[0, 1, 2], [0, 2, 3]];
    for (const solid of [false, true]) expectRasterIdentical(verts, tris, { resolution: 32, solid });
  });

  it("watertight cube with solid fill, and per-triangle colorOf", () => {
    const { verts, tris } = cubeMesh();
    expectRasterIdentical(verts, tris, { resolution: 16, solid: true, mapColorId: 7 });
    expectRasterIdentical(verts, tris, { resolution: 16, solid: true, colorOf: (t) => 2 + (t % 200) });
  });

  it("invalid triangle indices (NaN / negative / out of range) are skipped identically", () => {
    const { verts, tris } = cubeMesh();
    const dirty: Tri[] = [[NaN, 0, 1], [-1, 2, 3], [0, 1, 99], [1.5, 2, 3], ...tris];
    for (const solid of [false, true]) expectRasterIdentical(verts, dirty, { resolution: 12, solid });
  });

  it("randomized mesh sweep: seeds x resolutions x solid, all byte-identical", () => {
    for (const seed of [1, 42, 0xbeef, 0x9e3779b9]) {
      for (const res of [8, 21, 40]) {
        const { verts, tris } = randomMesh(seed, 80, 12);
        for (const solid of [false, true]) {
          expectRasterIdentical(verts, tris, { resolution: res, solid, mapColorId: 2 + (seed % 200) });
        }
      }
    }
  });
});

// hollow box shell with optional punched holes -> exercises the flood entering through openings
function shellVolume(sx: number, sy: number, sz: number, holes: Array<[number, number, number]> = []): VoxelVolume {
  const v = createVolume(sx, sy, sz);
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) setVoxel(v, x, y, z, 7);
  for (const [x, y, z] of holes) setVoxel(v, x, y, z, 255);
  return v;
}

function expectSolidifyIdentical(build: () => VoxelVolume, color: number): { opt: VoxelVolume; ref: VoxelVolume } {
  const opt = build();
  const ref = cloneVolume(opt);
  solidify(opt, color);
  solidifyReference(ref, color);
  expectVolumesByteIdentical(opt, ref);
  return { opt, ref };
}

describe("solidify is byte-identical to the verbatim reference", () => {
  it("sealed shells fill; non-cubic volumes and 1-thin slabs match", () => {
    const { opt } = expectSolidifyIdentical(() => shellVolume(12, 12, 12), 9);
    expect(countSolid(opt)).toBe(12 * 12 * 12); // sealed -> fully filled
    expectSolidifyIdentical(() => shellVolume(19, 7, 31), 9); // non-cubic
    expectSolidifyIdentical(() => shellVolume(9, 9, 1), 9); // single-plane volume
    expectSolidifyIdentical(() => shellVolume(2, 2, 2), 9); // no interior at all
    expectSolidifyIdentical(() => createVolume(5, 6, 7), 9); // all-air -> nothing to fill
  });

  it("a shell with a hole does NOT fill (the flood pours in through it), identically", () => {
    const holed = expectSolidifyIdentical(() => shellVolume(12, 12, 12, [[6, 6, 0]]), 9);
    // the interior stayed open: only the shell (minus the punched cell) is solid
    expect(countSolid(holed.opt)).toBeLessThan(12 * 12 * 12 / 2);
    // corner and edge holes too (the flood enters along boundary edges)
    expectSolidifyIdentical(() => shellVolume(10, 10, 10, [[0, 0, 0], [9, 5, 9]]), 9);
  });

  it("randomized volume sweep: scattered solids in non-cubic boxes, all byte-identical", () => {
    for (const seed of [3, 77, 0xc0ffee]) {
      expectSolidifyIdentical(() => {
        const rnd = mulberry32(seed);
        const v = createVolume(17, 23, 11);
        const cells = Math.floor(v.data.length * 0.3);
        for (let k = 0; k < cells; k++) {
          const i = Math.floor(rnd() * v.data.length);
          v.data[i] = 2 + Math.floor(rnd() * 200);
        }
        return v;
      }, 13);
    }
  });
});

// Same-run interleaved A/B (same protocol as dither-perf.test.ts / rgbscreen-perf.test.ts):
// ref/opt ORDER alternates each round so whoever runs second inherits the first's GC debt equally;
// compare MEDIANS so a stray GC/scheduler spike in one round cannot poison the result; retry so a
// false failure needs a hostile phase across every attempt while a real regression fails them all.
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
}

function timedAB(runRef: () => unknown, runOpt: () => unknown, rounds: number): { refMs: number; optMs: number } {
  const timed = (fn: () => unknown): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  const refTimes: number[] = [];
  const optTimes: number[] = [];
  for (let iter = 0; iter < rounds; iter++) {
    if (iter % 2 === 0) {
      refTimes.push(timed(runRef));
      optTimes.push(timed(runOpt));
    } else {
      optTimes.push(timed(runOpt));
      refTimes.push(timed(runRef));
    }
  }
  return { refMs: medianOf(refTimes), optMs: medianOf(optTimes) };
}

describe("model-import perf (same-run interleaved A/B vs the verbatim reference)", () => {
  it("trisToVolume is byte-identical AND >=1.15x faster on a dense random mesh", { retry: 2, timeout: 120000 }, () => {
    const { verts, tris } = randomMesh(0x5eed, 4000, 12);
    const opts: RasterOptions = { resolution: 40, mapColorId: 6 };
    const runRef = () => trisToVolumeReference(verts, tris, opts);
    const runOpt = () => trisToVolume(verts, tris, opts);
    expectVolumesByteIdentical(runOpt(), runRef()); // byte identity on the timed input + JIT warmup
    const { refMs, optMs } = timedAB(runRef, runOpt, 12);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // measured ~1.4x locally (the barycentric FP math dominates and is identical in both);
    // assert a conservative floor so a busy CI box cannot flake the gate
    expect(refMs / optMs).toBeGreaterThanOrEqual(1.15);
  });

  it("solidify is byte-identical AND >=3x faster on a 96^3 shell", { retry: 2, timeout: 120000 }, () => {
    const size = 96;
    // rebuild per run OUTSIDE the timed region (solidify mutates in place)
    const pristine = shellVolume(size, size, size);
    let scratchRef!: VoxelVolume;
    let scratchOpt!: VoxelVolume;
    const runRef = () => solidifyReference(scratchRef, 7);
    const runOpt = () => solidify(scratchOpt, 7);
    // byte identity on the timed shape + JIT warmup
    scratchRef = cloneVolume(pristine);
    scratchOpt = cloneVolume(pristine);
    runRef();
    runOpt();
    expectVolumesByteIdentical(scratchOpt, scratchRef);
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    for (let iter = 0; iter < 12; iter++) {
      if (iter % 2 === 0) {
        scratchRef = cloneVolume(pristine);
        refTimes.push(timed(runRef));
        scratchOpt = cloneVolume(pristine);
        optTimes.push(timed(runOpt));
      } else {
        scratchOpt = cloneVolume(pristine);
        optTimes.push(timed(runOpt));
        scratchRef = cloneVolume(pristine);
        refTimes.push(timed(runRef));
      }
    }
    const refMs = medianOf(refTimes);
    const optMs = medianOf(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // measured ~19x locally (boundary-plane seed kills the O(volume) seed scan; the Int32Array
    // index stack kills the triple-push + 6-closure-calls-per-pop); conservative floor for CI
    expect(refMs / optMs).toBeGreaterThanOrEqual(3);
  });
});
