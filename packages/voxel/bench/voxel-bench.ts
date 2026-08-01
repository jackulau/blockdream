// Voxel-builder micro-benchmark. Times the volume-FILL hot paths this package owns:
// 2D->3D solid inflation (imageToSolid), flat/heightmap extrusion (imageToVolume), the
// orthographic re-projection (volumeToFrame), the interior flood-fill (solidify) and the
// sparse iterator (forEachSolid). These are the loops the optimisation pass targets; the
// export-side merges (emit-commands greedyBoxes, the web greedy mesher) are already greedy
// and live in other packages, so they are intentionally NOT measured here.
//
// Inputs are DETERMINISTIC (seeded mulberry32, fixed sizes) so runs are reproducible.
//
// Two outputs:
//   • absolute timings (runBench) — machine + load dependent, reference only, NOT a before/after delta;
//   • a rigorous A/B (runAB) — each optimized path vs a bounds-checked reference of the SAME work,
//     interleaved in the same run, so the speedup is a true same-machine measurement.
//
// Run:  pnpm exec tsx packages/voxel/bench/voxel-bench.ts
// Writes bench/BASELINE.md (an absolute-timings + A/B snapshot) on the first run if it is absent.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid } from "../src/depth";
import { imageToVolume } from "../src/voxelize";
import { volumeToFrame } from "../src/project";
import { solidify } from "../src/obj";
import { spinSequence, spinSequenceReference, spin, padXZToSquare } from "../src/spin";
import { createVolume, setVoxel, getVoxel, fillRun, EMPTY, forEachSolid, countSolid, type VoxelVolume } from "../src/volume";

// ---- deterministic PRNG (no Math.random → reproducible inputs) ----
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

// A centred filled disc on a uniform border background, with a radial colour gradient inside the
// disc (varied map-colour ids 2..240). Exercises border-background detection AND the silhouette
// distance transform (both have real, non-trivial work to do on this shape).
function discFrame(size: number, seed = 0x9e3779b9): QuantizedFrame {
  const rnd = mulberry32(seed);
  const mapColorId = new Uint8Array(size * size);
  const paletteIndex = new Int32Array(size * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size * 0.42;
  const BG = 1; // border background colour
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      let id: number;
      if (d <= r) {
        // radial + a little noise → many distinct columns (varied colours, varied thickness)
        const t = d / r;
        id = 2 + (Math.floor(t * 200 + rnd() * 40) % 238);
      } else {
        id = BG;
      }
      mapColorId[i] = id;
      paletteIndex[i] = id;
    }
  }
  return { width: size, height: size, mapColorId, paletteIndex };
}

// A hollow box shell volume (6 faces set, interior air) → exercises solidify's flood-fill.
function shellVolume(sx: number, sy: number, sz: number): VoxelVolume {
  const v = createVolume(sx, sy, sz);
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) setVoxel(v, x, y, z, 7);
  return v;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// time a thunk: `warmup` untimed runs, then `iters` timed; return median ms.
function timeIt(fn: () => void, iters: number, warmup: number): number {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

export interface BenchStage {
  name: string;
  ms: number;
  /** elements processed (voxels or pixels) — drives the Mvox/s throughput column. */
  units: number;
}

export interface BenchConfig {
  imgSize?: number; // disc image edge for imageToSolid / imageToVolume
  flatDepth?: number; // Z thickness for the flat extrusion
  shellSize?: number; // hollow-box edge for solidify
  iters?: number;
  warmup?: number;
}

export function runBench(cfg: BenchConfig = {}): BenchStage[] {
  const imgSize = cfg.imgSize ?? 256;
  const flatDepth = cfg.flatDepth ?? 16;
  const shellSize = cfg.shellSize ?? 96;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;

  const frame = discFrame(imgSize);
  const px = imgSize * imgSize;
  const stages: BenchStage[] = [];

  // 1. 2D image → centred double-sided solid (silhouette DT + per-pixel column fill)
  let solid!: VoxelVolume;
  stages.push({
    name: "imageToSolid",
    ms: timeIt(() => {
      solid = imageToSolid(frame, { maxDepth: 24 });
    }, iters, warmup),
    units: solid ? solid.sx * solid.sy * solid.sz : px,
  });

  // 2. flat extrusion (pure column fill, no DT) — the simplest fill loop
  stages.push({
    name: "imageToVolume(flat)",
    ms: timeIt(() => {
      imageToVolume(frame, { mode: "flat", depth: flatDepth });
    }, iters, warmup),
    units: px * flatDepth,
  });

  // 3. heightmap extrusion (top-down field → columns)
  stages.push({
    name: "imageToVolume(heightmap)",
    ms: timeIt(() => {
      imageToVolume(frame, { mode: "heightmap", maxHeight: flatDepth, heightOf: (id) => (id % 16) / 16 });
    }, iters, warmup),
    units: px * flatDepth,
  });

  // 4. orthographic re-projection (per-column nearest-solid scan)
  stages.push({
    name: "volumeToFrame",
    ms: timeIt(() => {
      volumeToFrame(solid);
    }, iters, warmup),
    units: solid.sx * solid.sy * solid.sz,
  });

  // 5. interior flood-fill of a hollow shell (full-volume scan + stack fill)
  const shellTotal = shellSize * shellSize * shellSize;
  stages.push({
    name: "solidify(shell)",
    ms: timeIt(() => {
      solidify(shellVolume(shellSize, shellSize, shellSize), 7);
    }, iters, warmup),
    units: shellTotal,
  });

  // 6. sparse iterator over a dense solid (forEachSolid — used by animate/emit)
  let counted = 0;
  stages.push({
    name: "forEachSolid",
    ms: timeIt(() => {
      counted = 0;
      forEachSolid(solid, () => {
        counted++;
      });
    }, iters, warmup),
    units: solid.sx * solid.sy * solid.sz,
  });
  // keep `counted` honest (and ensure the loop isn't optimised away)
  if (counted !== countSolid(solid)) throw new Error(`forEachSolid mismatch ${counted} != ${countSolid(solid)}`);

  // 7. bake a Y-spin (the --animate spin path: cube-pad X/Z + N sampled rotations) — the new
  //    placement code path's scaling cost (a wide-shallow build sweeps a square footprint).
  const spinFrames = 8;
  stages.push({
    name: "spinSequence",
    ms: timeIt(() => {
      spinSequence(solid, spinFrames);
    }, iters, warmup),
    units: solid.sx * solid.sy * solid.sz * spinFrames,
  });

  return stages;
}

// ---- Rigorous in-run A/B: optimized vs a bounds-checked reference -------------------------------
// WHY: the old "vs baseline.json" print compared a current run against a SINGLE STORED SNAPSHOT
// captured once at whatever machine load existed then — an adversarial audit correctly flagged that
// as not a valid A/B (its absolute numbers can be several-x off a fresh run under different load, so
// the headline % was unreliable). These stages instead time the OPTIMIZED path against a
// BOUNDS-CHECKED reference doing the SAME work, INTERLEAVED in the same run, so the ratio is a true
// same-machine measure of exactly what D2 changed (dropping the per-voxel inBounds branch). It is
// also honest about WHERE the win is: large on full-volume scans, marginal where an early-exit
// already skips most voxels (projection of a solid-front volume).
export interface ABStage {
  name: string;
  optMs: number;
  refMs: number;
  speedup: number; // refMs / optMs  (>1 = optimized faster)
}

// alternate opt/ref each rep so CPU-load drift hits both equally; reset hooks run OUTSIDE timing.
function timeAB(
  opt: () => void,
  ref: () => void,
  iters: number,
  warmup: number,
  resetOpt: () => void = () => {},
  resetRef: () => void = () => {},
): { optMs: number; refMs: number } {
  for (let i = 0; i < warmup; i++) {
    resetOpt(); opt();
    resetRef(); ref();
  }
  const o: number[] = [];
  const r: number[] = [];
  for (let i = 0; i < iters; i++) {
    resetOpt();
    let t = performance.now();
    opt();
    o.push(performance.now() - t);
    resetRef();
    t = performance.now();
    ref();
    r.push(performance.now() - t);
  }
  return { optMs: median(o), refMs: median(r) };
}

export function runAB(cfg: BenchConfig = {}): ABStage[] {
  const size = cfg.imgSize ?? 256;
  const depth = cfg.flatDepth ?? 16;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;
  const out: ABStage[] = [];

  // 1. column fill — fillRun (opt) vs a bounds-checked setVoxel loop (the pre-D2 way). Overwrites
  //    each rep, so no reset needed. This is the imageToSolid/imageToVolume inner-loop change.
  {
    const v = createVolume(size, size, depth);
    const zStride = v.sx * v.sy;
    const color = (x: number, y: number) => ((x + y) & 0xfe) + 2;
    const opt = () => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) fillRun(v, x + v.sx * y, zStride, depth, color(x, y));
    };
    const ref = () => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let z = 0; z < depth; z++) setVoxel(v, x, y, z, color(x, y));
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "column-fill", optMs, refMs, speedup: refMs / optMs });
  }

  // 2. full-volume scan-fill (solidify's final loop) — linear data[] (opt) vs getVoxel/setVoxel
  //    triple loop (ref). Both reset to all-EMPTY before each timed rep so each fills the same work.
  {
    const vOpt = createVolume(size >> 1, size >> 1, depth * 4);
    const vRef = createVolume(size >> 1, size >> 1, depth * 4);
    const outside = new Uint8Array(vOpt.data.length); // all-zero → every cell is "interior" → filled
    const opt = () => {
      const d = vOpt.data;
      for (let i = 0; i < d.length; i++) if (d[i] === EMPTY && !outside[i]) d[i] = 7;
    };
    const ref = () => {
      let i = 0;
      for (let z = 0; z < vRef.sz; z++)
        for (let y = 0; y < vRef.sy; y++)
          for (let x = 0; x < vRef.sx; x++) {
            if (getVoxel(vRef, x, y, z) === EMPTY && !outside[i]) setVoxel(vRef, x, y, z, 7);
            i++;
          }
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup, () => vOpt.data.fill(EMPTY), () => vRef.data.fill(EMPTY));
    out.push({ name: "full-scan-fill", optMs, refMs, speedup: refMs / optMs });
  }

  // 3. projection column scan — direct-index (opt) vs getVoxel (ref), read-only, early-exit on the
  //    first solid voxel. On a solid-front volume the early-exit already skips most cells, so the
  //    bounds-check removal saves little here — this stage exists to show that honestly.
  {
    const v = imageToSolid(discFrame(size), { maxDepth: depth * 2 });
    const zStride = v.sx * v.sy;
    const data = v.data;
    const opt = () => {
      for (let y = 0; y < v.sy; y++) {
        const base = v.sx * y;
        for (let x = 0; x < v.sx; x++) {
          let idx = base + x;
          for (let z = 0; z < v.sz; z++) {
            if (data[idx] !== EMPTY) break;
            idx += zStride;
          }
        }
      }
    };
    const ref = () => {
      for (let y = 0; y < v.sy; y++)
        for (let x = 0; x < v.sx; x++)
          for (let z = 0; z < v.sz; z++) if (getVoxel(v, x, y, z) !== EMPTY) break;
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "project-scan", optMs, refMs, speedup: refMs / optMs });
  }

  // 4. baked spin (goal 045) — optimized spinSequence (Y-invariant trig hoisted out + air-column skip)
  //    vs the generic inverse spin() doing the SAME rotation on the cube-padded build. The two produce
  //    BYTE-IDENTICAL output (asserted in spin.test.ts), so this is a true same-work timing of the win.
  {
    const build = imageToSolid(discFrame(size), { maxDepth: depth });
    const padded = padXZToSquare(build);
    const frames = 6;
    const opt = () => {
      spinSequence(build, frames);
    };
    const ref = () => {
      spin(padded, frames, "y");
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "spinSequence", optMs, refMs, speedup: refMs / optMs });
  }

  // 5. spinSequence inner Y copy (goal 089 D19): hoisted running indices (opt) vs the verbatim
  //    getVoxel/setVoxel column copy (spinSequenceReference). Byte-identical (spin-perf.test.ts);
  //    isolates exactly what D19 changed (the per-voxel inBounds + voxelIndex overhead).
  {
    const build = imageToSolid(discFrame(size), { maxDepth: depth });
    const frames = 6;
    const opt = () => {
      spinSequence(build, frames);
    };
    const ref = () => {
      spinSequenceReference(build, frames);
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "spinSequence-inner", optMs, refMs, speedup: refMs / optMs });
  }

  return out;
}

// ---- CLI: print table, manage baseline ----
function fmt(stages: BenchStage[]): string {
  const rows = stages.map((s) => {
    const mvox = s.units / 1e6 / (s.ms / 1000); // M elements / second
    return `| ${s.name.padEnd(26)} | ${s.ms.toFixed(3).padStart(9)} | ${mvox.toFixed(1).padStart(9)} |`;
  });
  return [
    "| stage                      |   med (ms) |  M elem/s |",
    "| -------------------------- | ---------: | --------: |",
    ...rows,
  ].join("\n");
}

function fmtAB(stages: ABStage[]): string {
  const rows = stages.map(
    (s) => `| ${s.name.padEnd(16)} | ${s.refMs.toFixed(3).padStart(9)} | ${s.optMs.toFixed(3).padStart(9)} | ${s.speedup.toFixed(2).padStart(7)}x |`,
  );
  return [
    "| stage            | ref (ms) | opt (ms) | speedup |",
    "| ---------------- | -------: | -------: | ------: |",
    ...rows,
  ].join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "BASELINE.md");
  const stages = runBench();
  console.log("\nVoxel builder benchmark (deterministic disc input, median of timed runs)\n");
  console.log("Absolute timings (machine + load dependent — NOT a before/after comparison):\n");
  console.log(fmt(stages));

  // The rigorous comparison: optimized vs a bounds-checked reference of the SAME work, interleaved
  // in THIS run. ref=pre-D2 (getVoxel/setVoxel), opt=direct-index/fillRun. speedup = ref/opt.
  const ab = runAB();
  console.log("\nA/B: optimized vs bounds-checked reference (same run, same machine):\n");
  console.log(fmtAB(ab));
  console.log(
    "\n(full-scan-fill = solidify's full-volume loop; column-fill = imageToSolid/imageToVolume inner loop;\n project-scan early-exits on the solid front face, so its bounds-check removal is honestly marginal.)",
  );

  if (!existsSync(mdPath)) {
    writeFileSync(
      mdPath,
      `# Voxel builder benchmark snapshot\n\nDeterministic disc input. \`pnpm exec tsx packages/voxel/bench/voxel-bench.ts\`.\n\n` +
        `## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)\n\n${fmt(stages)}\n\n` +
        `## A/B: optimized vs bounds-checked reference (same run - the rigorous comparison)\n\n${fmtAB(ab)}\n`,
    );
    console.log(`\nsnapshot written -> ${mdPath}`);
  }
}
