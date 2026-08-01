// Audio pitch-detection micro-benchmark. Times the ONE hot path this package owns: detectPitchHz,
// which analyzeAudio calls once per 20ms hop (so a 60s --music render pays ~3000 calls of
// O(n*maxLag) autocorrelation - see packages/cli/src/render.ts). Workloads model the three window
// classes a real clip mixes: fully VOICED (every lag pays its dot product), TRANSIENT clicks
// (degenerate half-window energy -> the D20 gate skips every dot product) and SILENCE (the goal-067
// rmsGate early-out).
//
// Inputs are DETERMINISTIC (seeded mulberry32, fixed sizes) so runs are reproducible.
//
// Two outputs (same conventions as packages/voxel/bench/voxel-bench.ts):
//   • absolute timings (runBench) — machine + load dependent, reference only, NOT a before/after delta;
//   • a rigorous A/B (runAB) — the optimized detectPitchHz vs its verbatim reference twin on the
//     SAME work, interleaved in the same run, so the speedup is a true same-machine measurement.
//
// Run:  pnpm exec tsx packages/audio/bench/pitch-bench.ts
// Writes bench/BASELINE.md (an absolute-timings + A/B snapshot) on the first run if it is absent.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectPitchHz, detectPitchHzReference, analyzeAudio, type PitchResult } from "../src/index";

const SR = 44100;

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

/** Linear chirp with a phase accumulator - a real sweep, every window voiced. */
function sweep(fromHz: number, toHz: number, ms: number, amp = 0.8): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = fromHz + ((toHz - fromHz) * i) / n;
    phase += (2 * Math.PI * hz) / SR;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

function noise(ms: number, seed: number, amp = 0.5): Float32Array {
  const rnd = mulberry32(seed);
  const n = Math.round((ms / 1000) * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rnd() * 2 - 1);
  return out;
}

const WIN_LEN = Math.round(0.046 * SR); // analyzeAudio's default 46ms window
const HOP = Math.round(0.02 * SR); // render.ts --music hop (20ms)

/** One click at the start of each non-overlapping window -> every lag's denom degenerates. */
function clickClip(windows: number): Float32Array {
  const out = new Float32Array(windows * WIN_LEN);
  for (let k = 0; k < windows; k++) {
    out[k * WIN_LEN] = k % 2 ? 0.9 : -0.9;
    out[k * WIN_LEN + 1] = 0.4;
  }
  return out;
}

type Detect = (w: Float32Array, sr: number, lo: number, hi: number, gate?: number) => PitchResult;

/** Hop a clip exactly like analyzeAudio; returns an accumulator so the loop cannot be elided. */
function hopBatch(fn: Detect, clip: Float32Array, hop: number, rmsGate = 0): number {
  let acc = 0;
  for (let start = 0; start + WIN_LEN <= clip.length; start += hop) {
    acc += fn(clip.subarray(start, start + WIN_LEN), SR, 110, 1200, rmsGate).hz;
  }
  return acc;
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
  /** windows processed — drives the windows/s throughput column. */
  units: number;
}

export interface BenchConfig {
  voicedMs?: number; // sweep length for the voiced stages
  iters?: number;
  warmup?: number;
}

export function runBench(cfg: BenchConfig = {}): BenchStage[] {
  const voicedMs = cfg.voicedMs ?? 2000;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;

  const voiced = sweep(110, 1200, voicedMs);
  const clicks = clickClip(21);
  const quiet = noise(1000, 0x5eed, 0.001); // real signal far below a 4% peak gate
  const stages: BenchStage[] = [];
  const windowsIn = (clip: Float32Array, hop: number): number => Math.floor((clip.length - WIN_LEN) / hop) + 1;

  // 1. voiced sweep — every hop pays the full O(n*maxLag) pitch search (the honest common case)
  stages.push({
    name: "detectPitchHz(voiced)",
    ms: timeIt(() => {
      hopBatch(detectPitchHz, voiced, HOP);
    }, iters, warmup),
    units: windowsIn(voiced, HOP),
  });

  // 2. transient clicks — degenerate denom skips every dot product (the D20 win)
  stages.push({
    name: "detectPitchHz(transient)",
    ms: timeIt(() => {
      hopBatch(detectPitchHz, clicks, WIN_LEN);
    }, iters, warmup),
    units: windowsIn(clicks, WIN_LEN),
  });

  // 3. rmsGate early-out (goal 067) — quiet windows cost only the O(n) energy pass
  stages.push({
    name: "detectPitchHz(rms-gated)",
    ms: timeIt(() => {
      hopBatch(detectPitchHz, quiet, HOP, 0.04);
    }, iters, warmup),
    units: windowsIn(quiet, HOP),
  });

  // 4. the full caller path: analyzeAudio over the voiced sweep (windowing + gating + note mapping)
  stages.push({
    name: "analyzeAudio(voiced)",
    ms: timeIt(() => {
      analyzeAudio(voiced, SR);
    }, iters, warmup),
    units: Math.floor((voiced.length - WIN_LEN) / (Math.round(0.05 * SR))) + 1,
  });

  return stages;
}

// ---- Rigorous in-run A/B: optimized vs the verbatim reference twin ------------------------------
// Same protocol as the voxel bench: alternate opt/ref each rep so CPU-load drift hits both equally;
// medians so a stray GC/scheduler spike cannot poison the result. Byte-for-byte output identity is
// locked separately in test/pitch-perf.test.ts.
export interface ABStage {
  name: string;
  optMs: number;
  refMs: number;
  speedup: number; // refMs / optMs  (>1 = optimized faster)
}

function timeAB(opt: () => void, ref: () => void, iters: number, warmup: number): { optMs: number; refMs: number } {
  for (let i = 0; i < warmup; i++) {
    opt();
    ref();
  }
  const o: number[] = [];
  const r: number[] = [];
  for (let i = 0; i < iters; i++) {
    if (i % 2 === 0) {
      let t = performance.now();
      opt();
      o.push(performance.now() - t);
      t = performance.now();
      ref();
      r.push(performance.now() - t);
    } else {
      let t = performance.now();
      ref();
      r.push(performance.now() - t);
      t = performance.now();
      opt();
      o.push(performance.now() - t);
    }
  }
  return { optMs: median(o), refMs: median(r) };
}

export function runAB(cfg: BenchConfig = {}): ABStage[] {
  const voicedMs = cfg.voicedMs ?? 2000;
  const iters = cfg.iters ?? 9;
  const warmup = cfg.warmup ?? 3;
  const out: ABStage[] = [];

  // 1. voiced path — expected ~parity (dot products dominate; the scratch removes allocator churn
  //    a wall-clock median can't see). Kept to show that honestly.
  {
    const voiced = sweep(110, 1200, voicedMs);
    const { optMs, refMs } = timeAB(
      () => {
        hopBatch(detectPitchHz, voiced, HOP);
      },
      () => {
        hopBatch(detectPitchHzReference, voiced, HOP);
      },
      iters,
      warmup,
    );
    out.push({ name: "voiced-sweep", optMs, refMs, speedup: refMs / optMs });
  }

  // 2. transient path — denom computed BEFORE the dot product skips all ~366 O(n) dots per window
  //    that the reference pays and then discards. This is where the D20 wall win lives.
  {
    const clicks = clickClip(21);
    const { optMs, refMs } = timeAB(
      () => {
        hopBatch(detectPitchHz, clicks, WIN_LEN);
      },
      () => {
        hopBatch(detectPitchHzReference, clicks, WIN_LEN);
      },
      iters,
      warmup,
    );
    out.push({ name: "transient-clicks", optMs, refMs, speedup: refMs / optMs });
  }

  return out;
}

// ---- CLI: print table, manage baseline ----
function fmt(stages: BenchStage[]): string {
  const rows = stages.map((s) => {
    const wps = s.units / (s.ms / 1000);
    return `| ${s.name.padEnd(24)} | ${s.ms.toFixed(3).padStart(9)} | ${wps.toFixed(0).padStart(9)} |`;
  });
  return [
    "| stage                    |   med (ms) | windows/s |",
    "| ------------------------ | ---------: | --------: |",
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
  console.log("\nAudio pitch-detection benchmark (deterministic PCM, median of timed runs)\n");
  console.log("Absolute timings (machine + load dependent — NOT a before/after comparison):\n");
  console.log(fmt(stages));

  const ab = runAB();
  console.log("\nA/B: optimized vs verbatim reference twin (same run, same machine):\n");
  console.log(fmtAB(ab));
  console.log(
    "\n(voiced-sweep = every window pays the full O(n*maxLag) search, honestly ~parity;\n transient-clicks = degenerate denom skips every dot product, the D20 wall win.)",
  );

  if (!existsSync(mdPath)) {
    writeFileSync(
      mdPath,
      `# Audio pitch-detection benchmark snapshot\n\nDeterministic PCM. \`pnpm exec tsx packages/audio/bench/pitch-bench.ts\`.\n\n` +
        `## Absolute timings (machine + load dependent - reference only, NOT a before/after delta)\n\n${fmt(stages)}\n\n` +
        `## A/B: optimized vs verbatim reference twin (same run - the rigorous comparison)\n\n${fmtAB(ab)}\n`,
    );
    console.log(`\nsnapshot written -> ${mdPath}`);
  }
}
