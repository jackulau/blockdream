// Voxel-builder micro-benchmark. Times the volume-FILL hot paths this package owns:
// 2D->3D solid inflation (imageToSolid), flat/heightmap extrusion (imageToVolume), the
// orthographic re-projection (volumeToFrame), the interior flood-fill (solidify) and the
// sparse iterator (forEachSolid). These are the loops the optimisation pass targets; the
// export-side merges (emit-commands greedyBoxes, the web greedy mesher) are already greedy
// and live in other packages, so they are intentionally NOT measured here.
//
// Inputs are DETERMINISTIC (seeded mulberry32, fixed sizes) so two runs are directly
// comparable — that is what lets a before/after diff prove a speedup rather than assert one.
//
// Run:  pnpm exec tsx packages/voxel/bench/voxel-bench.ts
// The first run writes bench/baseline.json + bench/BASELINE.md; later runs print a delta vs it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { QuantizedFrame } from "@blockdream/color-core";
import { imageToSolid } from "../src/depth";
import { imageToVolume } from "../src/voxelize";
import { volumeToFrame } from "../src/project";
import { solidify } from "../src/obj";
import { createVolume, setVoxel, forEachSolid, countSolid, type VoxelVolume } from "../src/volume";

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

  return stages;
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const jsonPath = join(here, "baseline.json");
  const mdPath = join(here, "BASELINE.md");
  const stages = runBench();
  console.log("\nVoxel builder benchmark (deterministic disc input, median of timed runs)\n");
  console.log(fmt(stages));

  const cur: Record<string, number> = {};
  for (const s of stages) cur[s.name] = s.ms;

  if (existsSync(jsonPath)) {
    const base = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, number>;
    console.log("\nvs baseline (baseline.json):");
    for (const s of stages) {
      const b = base[s.name];
      if (b == null) continue;
      const pct = ((s.ms - b) / b) * 100;
      const tag = pct <= -5 ? "FASTER" : pct >= 5 ? "slower" : "~same";
      console.log(`  ${s.name.padEnd(26)} ${b.toFixed(3)} -> ${s.ms.toFixed(3)} ms  (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%  ${tag})`);
    }
    console.log("\n(baseline.json kept; delete it to re-baseline)");
  } else {
    writeFileSync(jsonPath, JSON.stringify(cur, null, 2) + "\n");
    writeFileSync(
      mdPath,
      `# Voxel builder benchmark baseline\n\nDeterministic disc input. Median of timed runs (\`pnpm exec tsx packages/voxel/bench/voxel-bench.ts\`).\nNumbers are machine-dependent; what matters is the **before/after delta on the same machine**.\n\n${fmt(stages)}\n`,
    );
    console.log(`\nbaseline written -> ${jsonPath} (+ BASELINE.md)`);
  }
}
