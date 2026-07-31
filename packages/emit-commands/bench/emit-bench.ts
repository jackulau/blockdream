// Emit-commands micro-benchmark. Times the command-emission hot paths this package owns:
// the rgbscreen per-frame delta loop (the millions-of-lines path on a real clip), the
// PRIMARY end-to-end TRUE-RGB pack generation, the greedy 3D box merge, the voxel frame
// delta encoder and both note-block music sequencer engines (playsound + redstone).
//
// Inputs are DETERMINISTIC (seeded LCG, fixed sizes) so runs are reproducible.
//
// Two outputs:
//   * absolute timings (runBench) - machine + load dependent, reference only, NOT a
//     before/after delta. End-to-end pack generation lives HERE on purpose: whole-pack
//     timing gates on the shared join/Map/GC floor (measured to be dominated by
//     garbage-collection landing spots), so it is honest context, not a rigorous ratio.
//   * a rigorous A/B (runAB) - each optimized path vs its RETAINED byte-identical
//     reference twin doing the SAME work, interleaved in the same run, so the speedup is
//     a true same-machine measurement. Only the two twins kept in src qualify:
//     rgbScreenDeltaLines vs referenceRgbScreenDeltaLines (rgbscreen.ts) and
//     greedyBoxes vs greedyBoxesSparse (fill.ts).
//
// Run:  pnpm exec tsx packages/emit-commands/bench/emit-bench.ts
// Writes bench/BASELINE.md (an absolute-timings + A/B snapshot) on the first run if it is absent.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NoteEvent } from "@blockdream/audio";
import { createVolume, type VoxelVolume } from "@blockdream/voxel";
import {
  argbInt,
  generateRgbScreenDatapack,
  generateRgbScreenDatapackReference,
  pixelUuid,
  referenceRgbScreenDeltaLines,
  rgbScreenDeltaLines,
  uuidString,
  type RgbScreenFrame,
} from "../src/rgbscreen";
import { greedyBoxes, greedyBoxesSparse, type PlacedCell } from "../src/fill";
import { computeVoxelDeltas } from "../src/datapack3d";
import { noteSequencer } from "../src/note-sequencer";
import { redstoneSequencer } from "../src/redstone-sequencer";

// ---- deterministic PRNG (no Math.random, so inputs are reproducible) ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Irregular per-frame pixel churn (some frames touch few pixels, some many; runs and
// singletons interleave) - the shape real video deltas have. Same construction as
// rgbscreen-perf.test.ts so the bench measures the workload the tests lock.
function makeClip(W: number, H: number, frameCount: number, churn: number): RgbScreenFrame[] {
  const rnd = lcg(0xbadc0de);
  const rndByte = () => (rnd() * 256) | 0;
  const n = W * H;
  const frames: RgbScreenFrame[] = [];
  let cur = new Int32Array(n);
  for (let i = 0; i < n; i++) cur[i] = argbInt(rndByte(), rndByte(), rndByte());
  frames.push({ width: W, height: H, argb: cur });
  for (let f = 1; f < frameCount; f++) {
    const next = new Int32Array(cur);
    const p = churn * (0.25 + 1.5 * rnd());
    for (let i = 0; i < n; i++) {
      if (rnd() < p) next[i] = argbInt(rndByte(), rndByte(), rndByte());
    }
    frames.push({ width: W, height: H, argb: next });
    cur = next;
  }
  return frames;
}

// A W x H x D block of cells in layered colour bands with sparse holes: bands give the
// greedy mesh real boxes to grow, holes stop it collapsing to one trivial fill.
function bandedCells(W: number, H: number, D: number): PlacedCell[] {
  const rnd = lcg(0x5eed);
  const cells: PlacedCell[] = [];
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (rnd() < 0.04) continue; // holes
        cells.push({ x, y, z, mapColorId: 2 + ((y >> 2) % 24) });
      }
  return cells;
}

// A short voxel animation: frame 0 is a solid banded box, later frames flip a churn
// subset of voxels (including solid<->air transitions) - what computeVoxelDeltas walks.
function makeVolumes(size: number, frameCount: number): VoxelVolume[] {
  const rnd = lcg(0x70c31);
  const volumes: VoxelVolume[] = [];
  const first = createVolume(size, size, size >> 1);
  const n = first.data.length;
  for (let i = 0; i < n; i++) first.data[i] = rnd() < 0.7 ? 2 + ((i >> 5) % 24) : 0;
  volumes.push(first);
  for (let f = 1; f < frameCount; f++) {
    const prev = volumes[f - 1]!;
    const next = createVolume(size, size, size >> 1);
    next.data.set(prev.data);
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.05) next.data[i] = rnd() < 0.5 ? 0 : 2 + ((rnd() * 24) | 0);
    }
    volumes.push(next);
  }
  return volumes;
}

// A deterministic note timeline with mixed instruments and irregular onsets.
function makeNotes(count: number): NoteEvent[] {
  const rnd = lcg(0x0075e5);
  const instruments = ["harp", "bass", "snare", "bell", "flute", "guitar", "pling"];
  const notes: NoteEvent[] = [];
  let tick = 0;
  for (let i = 0; i < count; i++) {
    tick += (rnd() * 4) | 0;
    notes.push({
      tick,
      note: (rnd() * 25) | 0,
      instrument: instruments[(rnd() * instruments.length) | 0]!,
      velocity: 0.4 + rnd() * 0.6,
    });
  }
  return notes;
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
  /** elements processed (pixels x frames, cells, voxels x frames, or notes). */
  units: number;
}

export interface BenchConfig {
  screenW?: number; // rgbscreen pixel-grid width
  screenH?: number; // rgbscreen pixel-grid height
  frameCount?: number; // rgbscreen clip length
  churn?: number; // per-frame pixel-change probability
  boxW?: number; // greedyBoxes cell block dims
  boxH?: number;
  boxD?: number;
  voxelSize?: number; // computeVoxelDeltas volume edge
  voxelFrames?: number;
  noteCount?: number; // sequencer timeline length
  iters?: number;
  warmup?: number;
}

export function runBench(cfg: BenchConfig = {}): BenchStage[] {
  const W = cfg.screenW ?? 64;
  const H = cfg.screenH ?? 48;
  const frameCount = cfg.frameCount ?? 96;
  const churn = cfg.churn ?? 0.4;
  const boxW = cfg.boxW ?? 64;
  const boxH = cfg.boxH ?? 64;
  const boxD = cfg.boxD ?? 32;
  const voxelSize = cfg.voxelSize ?? 48;
  const voxelFrames = cfg.voxelFrames ?? 8;
  const noteCount = cfg.noteCount ?? 600;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;

  const frames = makeClip(W, H, frameCount, churn);
  const n = W * H;
  const ns = "blockdream_rgb";
  const mergePrefix: string[] = new Array(n);
  for (let i = 0; i < n; i++) mergePrefix[i] = `data merge entity ${uuidString(pixelUuid(ns, i))} {background:`;
  const pairs: Array<[Int32Array, Int32Array]> = frames.map((fr, f) => [
    fr.argb,
    frames[(f - 1 + frames.length) % frames.length]!.argb,
  ]);

  const stages: BenchStage[] = [];

  // 1. the extracted delta hot loop over the whole clip (the millions-of-lines path)
  let deltaLines = 0;
  stages.push({
    name: "rgbScreenDeltaLines",
    ms: timeIt(() => {
      deltaLines = 0;
      for (const [cur, prev] of pairs) deltaLines += rgbScreenDeltaLines(cur, prev, mergePrefix).length;
    }, iters, warmup),
    units: n * frameCount,
  });
  if (deltaLines === 0) throw new Error("rgbScreenDeltaLines produced no lines");

  // 2. PRIMARY end-to-end path: whole TRUE-RGB pack (summons + all frame deltas + playback
  //    machinery). GC-noisy by nature - absolute section only, never a rigorous ratio.
  stages.push({
    name: "generateRgbScreenDatapack",
    ms: timeIt(() => {
      generateRgbScreenDatapack(frames);
    }, iters, warmup),
    units: n * frameCount,
  });

  // 3. the retained end-to-end reference twin, for load-dependent context beside stage 2
  stages.push({
    name: "generateRgbScreenDatapackReference",
    ms: timeIt(() => {
      generateRgbScreenDatapackReference(frames);
    }, iters, warmup),
    units: n * frameCount,
  });

  // 4. greedy 3D box merge (dense-grid path) over a banded cell block
  const cells = bandedCells(boxW, boxH, boxD);
  const resolve = (id: number) => `minecraft:wool_${id}`;
  stages.push({
    name: "greedyBoxes",
    ms: timeIt(() => {
      greedyBoxes(cells, resolve);
    }, iters, warmup),
    units: cells.length,
  });

  // 5. voxel animation delta encoding (goal 067's flat data[] walk; its pre-optimization
  //    reference was not retained in src, so this is an absolute stage only)
  const volumes = makeVolumes(voxelSize, voxelFrames);
  stages.push({
    name: "computeVoxelDeltas",
    ms: timeIt(() => {
      computeVoxelDeltas(volumes);
    }, iters, warmup),
    units: volumes[0]!.data.length * voxelFrames,
  });

  // 6. playsound music engine (goal 066): keyboard + tick-driven playsound sequencer
  const notes = makeNotes(noteCount);
  stages.push({
    name: "noteSequencer(playsound)",
    ms: timeIt(() => {
      noteSequencer(notes);
    }, iters, warmup),
    units: noteCount,
  });

  // 7. redstone music engine (goal 077): physical repeater delay-line + re-pulse metronome
  stages.push({
    name: "redstoneSequencer",
    ms: timeIt(() => {
      redstoneSequencer(notes);
    }, iters, warmup),
    units: noteCount,
  });

  return stages;
}

// ---- Rigorous in-run A/B: optimized vs its retained byte-identical reference twin ----
// Each pair times the optimized path against the reference kept verbatim in src doing the
// SAME work, INTERLEAVED in the same run, so the ratio is a true same-machine measure.
// Byte identity of each pair is locked elsewhere (rgbscreen-perf.test.ts,
// greedy-boxes.test.ts); this file only measures.
export interface ABStage {
  name: string;
  optMs: number;
  refMs: number;
  speedup: number; // refMs / optMs  (>1 = optimized faster)
}

// Interleave opt/ref with the ORDER alternating each rep: whoever runs second inherits
// the first's GC debt, so a fixed order systematically biases string-heavy pairs (same
// mitigation as rgbscreen-perf.test.ts). Medians shrug off one-off GC/scheduler spikes.
function timeAB(opt: () => void, ref: () => void, iters: number, warmup: number): { optMs: number; refMs: number } {
  for (let i = 0; i < warmup; i++) {
    opt();
    ref();
  }
  const o: number[] = [];
  const r: number[] = [];
  const timed = (fn: () => void): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  for (let i = 0; i < iters; i++) {
    if (i % 2 === 0) {
      o.push(timed(opt));
      r.push(timed(ref));
    } else {
      r.push(timed(ref));
      o.push(timed(opt));
    }
  }
  return { optMs: median(o), refMs: median(r) };
}

export function runAB(cfg: BenchConfig = {}): ABStage[] {
  const W = cfg.screenW ?? 64;
  const H = cfg.screenH ?? 48;
  const frameCount = cfg.frameCount ?? 96;
  const churn = cfg.churn ?? 0.4;
  const boxW = cfg.boxW ?? 64;
  const boxH = cfg.boxH ?? 64;
  const boxD = cfg.boxD ?? 32;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;
  const out: ABStage[] = [];

  // 1. rgbscreen delta lines - precomputed per-pixel prefix (opt) vs rebuilding the full
  //    command template per changed pixel (ref, kept verbatim in rgbscreen.ts). The
  //    end-to-end pack pair stays OUT of this section: whole-pack timing is GC-bound.
  {
    const frames = makeClip(W, H, frameCount, churn);
    const n = W * H;
    const ns = "blockdream_rgb";
    const uuids: string[] = new Array(n);
    const prefixes: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      uuids[i] = uuidString(pixelUuid(ns, i));
      prefixes[i] = `data merge entity ${uuids[i]} {background:`;
    }
    const pairs: Array<[Int32Array, Int32Array]> = frames.map((fr, f) => [
      fr.argb,
      frames[(f - 1 + frames.length) % frames.length]!.argb,
    ]);
    const opt = () => {
      for (const [cur, prev] of pairs) rgbScreenDeltaLines(cur, prev, prefixes);
    };
    const ref = () => {
      for (const [cur, prev] of pairs) referenceRgbScreenDeltaLines(cur, prev, uuids);
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "rgbscreen-delta-lines", optMs, refMs, speedup: refMs / optMs });
  }

  // 2. greedy 3D box merge - dense Uint16 grid with integer keys (opt, goal 050) vs the
  //    original string-keyed Map mesh (ref, retained in fill.ts as the oversize fallback).
  {
    const cells = bandedCells(boxW, boxH, boxD);
    const resolve = (id: number) => `minecraft:wool_${id}`;
    const opt = () => {
      greedyBoxes(cells, resolve);
    };
    const ref = () => {
      greedyBoxesSparse(cells, resolve);
    };
    const { optMs, refMs } = timeAB(opt, ref, iters, warmup);
    out.push({ name: "greedy-boxes", optMs, refMs, speedup: refMs / optMs });
  }

  return out;
}

// ---- CLI: print table, manage baseline ----
function fmt(stages: BenchStage[]): string {
  const rows = stages.map((s) => {
    const melem = s.units / 1e6 / (s.ms / 1000); // M elements / second
    return `| ${s.name.padEnd(34)} | ${s.ms.toFixed(3).padStart(9)} | ${melem.toFixed(1).padStart(9)} |`;
  });
  return [
    "| stage                              |   med (ms) |  M elem/s |",
    "| ---------------------------------- | ---------: | --------: |",
    ...rows,
  ].join("\n");
}

function fmtAB(stages: ABStage[]): string {
  const rows = stages.map(
    (s) => `| ${s.name.padEnd(22)} | ${s.refMs.toFixed(3).padStart(9)} | ${s.optMs.toFixed(3).padStart(9)} | ${s.speedup.toFixed(2).padStart(7)}x |`,
  );
  return [
    "| stage                  | ref (ms) | opt (ms) | speedup |",
    "| ---------------------- | -------: | -------: | ------: |",
    ...rows,
  ].join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const mdPath = join(here, "BASELINE.md");
  const stages = runBench();
  console.log("\nEmit-commands benchmark (deterministic seeded inputs, median of timed runs)\n");
  console.log("Absolute timings (machine + load dependent - NOT a before/after comparison):\n");
  console.log(fmt(stages));

  const ab = runAB();
  console.log("\nA/B: optimized vs retained byte-identical reference (same run, same machine):\n");
  console.log(fmtAB(ab));
  console.log(
    "\n(rgbscreen-delta-lines = the extracted per-frame hot loop; the end-to-end pack pair is\n absolute-only because whole-pack timing is dominated by the shared join/Map/GC floor.)",
  );

  if (!existsSync(mdPath)) {
    writeFileSync(
      mdPath,
      `# Emit-commands benchmark snapshot\n\nDeterministic seeded inputs. \`pnpm exec tsx packages/emit-commands/bench/emit-bench.ts\`.\n\n` +
        `## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)\n\n${fmt(stages)}\n\n` +
        `## A/B: optimized vs retained byte-identical reference (same run - the rigorous comparison)\n\n${fmtAB(ab)}\n`,
    );
    console.log(`\nsnapshot written -> ${mdPath}`);
  }
}
