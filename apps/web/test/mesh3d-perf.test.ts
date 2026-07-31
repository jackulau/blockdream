// Perf regression net for the optimized greedy mesher hot path (viewer3d rAF → showFrame →
// buildGroup → meshByMaterial → greedyQuads; every displayed frame of a long clip re-meshes, so
// this is what caps 3D preview fps). The optimized greedyQuads/meshByMaterial must stay
// BYTE-IDENTICAL to the retained references (greedyQuadsReference/meshByMaterialReference, the
// original boxed-index + number[]-push algorithms kept verbatim in the module), and they must
// actually be faster - A/B'd in the SAME process, interleaved with order alternation, so machine
// noise hits both sides equally (same discipline as pixel-export-perf.test.ts and
// packages/emit-commands/test/rgbscreen-perf.test.ts).

import { describe, it, expect } from "vitest";
import { createVolume, setVoxel, EMPTY, type VoxelVolume } from "@blockdream/voxel";
import {
  greedyQuads,
  greedyQuadsReference,
  meshByMaterial,
  meshByMaterialReference,
  type FaceDir,
  type MeshData,
  type Quad,
} from "../src/mesh3d";

/** Deterministic LCG so every volume is irregular but reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function solidCube(n: number, id: number): VoxelVolume {
  const v = createVolume(n, n, n);
  v.data.fill(id);
  return v;
}

/**
 * Web-preview-shaped slab: 256x144 image extruded 2 deep (what buildGroup meshes per frame),
 * block-arty 4x4 colour cells over ~24 ids with ~5% holes so the mask has runs, edges, and gaps.
 */
function previewSlab(w = 256, h = 144, depth = 2): VoxelVolume {
  const v = createVolume(w, h, depth);
  const rand = lcg(0x2bd1e5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rand() % 100 < 5) continue; // hole (stays EMPTY)
      const id = (((x >> 2) * 7 + (y >> 2) * 13) % 24) + (rand() % 100 < 8 ? 1 : 0);
      for (let z = 0; z < depth; z++) setVoxel(v, x, y, z, id % 24);
    }
  }
  return v;
}

/** ~45% solid noise over 12 ids: worst case for merging, exercises every mask branch. */
function randomVolume(n: number, seed: number): VoxelVolume {
  const v = createVolume(n, n, n);
  const rand = lcg(seed);
  for (let i = 0; i < v.data.length; i++) {
    const r = rand() % 100;
    if (r < 55) continue; // EMPTY
    v.data[i] = r % 12;
  }
  return v;
}

/** Every voxel a DISTINCT id (0..251, none EMPTY): no two faces ever merge, max key churn. */
function allDistinctVolume(): VoxelVolume {
  const v = createVolume(6, 6, 7); // 252 voxels, ids 0..251 all < EMPTY (255)
  for (let i = 0; i < v.data.length; i++) v.data[i] = i;
  return v;
}

function singleVoxelVolume(): VoxelVolume {
  const v = createVolume(5, 4, 3);
  setVoxel(v, 2, 1, 1, 9);
  return v;
}

function expectQuadsIdentical(opt: Quad[], ref: Quad[], label: string): void {
  expect(opt.length, `${label}: quad count`).toBe(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const a = opt[i]!;
    const b = ref[i]!;
    const same =
      a.id === b.id &&
      a.dir === b.dir &&
      a.reversed === b.reversed &&
      a.verts.every((x, k) => x === b.verts[k]) &&
      a.uv.every((x, k) => x === b.uv[k]);
    if (!same) expect(a, `${label}: quad ${i}`).toEqual(b); // rich diff on the first mismatch
  }
}

/** Element-exact typed-array equality via raw bytes (strictest: exact floats, exact ints). */
function expectMeshIdentical(opt: Map<string, MeshData>, ref: Map<string, MeshData>, label: string): void {
  expect([...opt.keys()], `${label}: material keys and their order`).toEqual([...ref.keys()]);
  for (const [key, r] of ref) {
    const o = opt.get(key)!;
    expect(o.id, `${label}/${key}: representative id`).toBe(r.id);
    for (const field of ["positions", "normals", "uvs", "indices"] as const) {
      const a = o[field];
      const b = r[field];
      expect(a.length, `${label}/${key}: ${field} length`).toBe(b.length);
      expect(
        Buffer.compare(
          Buffer.from(a.buffer, a.byteOffset, a.byteLength),
          Buffer.from(b.buffer, b.byteOffset, b.byteLength),
        ),
        `${label}/${key}: ${field} bytes`,
      ).toBe(0);
    }
  }
}

const singleKey = (id: number): string => `b${id}`;
const perFaceKey = (id: number, dir: FaceDir): string => `${id}:${dir}`;

describe("mesh3d optimized mesher vs retained reference", () => {
  const cases: Array<[string, () => VoxelVolume]> = [
    ["empty volume (all air)", () => createVolume(8, 8, 8)],
    ["single voxel in a 5x4x3 volume", singleVoxelVolume],
    ["flat slab 256x144x2 (web preview shape)", () => previewSlab()],
    ["random multi-material 64^3 noise", () => randomVolume(64, 0xc0ffee)],
    ["all-solid 32^3 cube", () => solidCube(32, 7)],
    ["every material id distinct (6x6x7, ids 0..251)", allDistinctVolume],
  ];

  for (const [name, make] of cases) {
    it(`is byte-identical to the reference: ${name}`, () => {
      const v = make();
      expectQuadsIdentical(greedyQuads(v), greedyQuadsReference(v), `${name} quads`);
      expectMeshIdentical(
        meshByMaterial(v, singleKey),
        meshByMaterialReference(v, singleKey),
        `${name} single-key`,
      );
      expectMeshIdentical(
        meshByMaterial(v, perFaceKey),
        meshByMaterialReference(v, perFaceKey),
        `${name} per-face-key`,
      );
    });
  }

  it("empty volume sanity: both mesher paths emit zero quads and zero groups", () => {
    const v = createVolume(8, 8, 8);
    expect(v.data.every((b) => b === EMPTY)).toBe(true);
    expect(greedyQuads(v).length).toBe(0);
    expect(meshByMaterial(v, singleKey).size).toBe(0);
  });

  // Same-run interleaved A/B on the whole hot call (meshByMaterial = greedyQuads + grouping,
  // exactly what buildGroup pays per frame). 10 rounds with the ref/opt ORDER alternating each
  // round: whoever runs second inherits the first's GC debt, so a fixed order systematically
  // biases the comparison; alternation cancels that. Compare MEDIANS: a major GC or an OS
  // scheduling spike lands in one arbitrary round, which poisons a sum and can even poison a min,
  // while the median ignores it on either side. retry: a timing inversion needs a sustained
  // hostile phase across EVERY attempt to fake a failure; a real regression loses all attempts.
  it(
    "optimized meshByMaterial is faster than the reference (same-run interleaved A/B, order-alternated, medians)",
    { retry: 2, timeout: 120000 },
    () => {
      const v = previewSlab(); // 256x144x2, the measured preview bottleneck shape
      const runRef = (): Map<string, MeshData> => meshByMaterialReference(v, singleKey);
      const runOpt = (): Map<string, MeshData> => meshByMaterial(v, singleKey);

      // warm both paths up (JIT) and re-assert identity on the exact perf workload
      expectMeshIdentical(runOpt(), runRef(), "perf slab warmup");
      // non-trivial workload guard: a realistic slab must produce a real quad load
      expect(greedyQuads(v).length).toBeGreaterThan(5000);

      const timed = (fn: () => unknown): number => {
        const t = performance.now();
        fn();
        return performance.now() - t;
      };
      const refTimes: number[] = [];
      const optTimes: number[] = [];
      for (let iter = 0; iter < 10; iter++) {
        if (iter % 2 === 0) {
          refTimes.push(timed(runRef));
          optTimes.push(timed(runOpt));
        } else {
          optTimes.push(timed(runOpt));
          refTimes.push(timed(runRef));
        }
      }
      const median = (xs: number[]): number => {
        const s = [...xs].sort((a, b) => a - b);
        return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
      };
      const refMs = median(refTimes);
      const optMs = median(optTimes);
      const speedup = refMs / optMs;
      console.log(
        `meshByMaterial A/B (medians of 10 order-alternated rounds, 256x144x2 slab): ` +
          `reference ${refMs.toFixed(2)} ms, optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(1)}x`,
      );
      expect(optMs).toBeGreaterThan(0);
      expect(refMs).toBeGreaterThan(0);
      // measured ~25x locally on the probe; assert a conservative floor so a busy CI box cannot
      // flake the gate while a genuine regression (losing either finding) still fails hard
      expect(speedup, `optimized must be >= 3x the reference (measured ${speedup.toFixed(1)}x)`).toBeGreaterThan(3);
    },
  );
});
