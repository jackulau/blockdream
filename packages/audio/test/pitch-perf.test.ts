// Locks the goal-089 D20 detectPitchHz gates (module-scratch prefix sums with explicit sq[0]=0,
// hoisted dot-product loop bound, denom-before-dot degenerate skip) against the verbatim
// pre-optimization reference twin: BIT-identity (Object.is per field, float summation order
// untouched) on real-ish PCM, then same-run interleaved A/B timing.

import { describe, it, expect } from "vitest";
import { detectPitchHz, detectPitchHzReference, type PitchResult } from "../src/index";

const SR = 44100;

// deterministic PRNG (same generator the voxel bench uses) so every run tests the same PCM
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

function sine(hz: number, ms: number, sampleRate = SR, amp = 0.9): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Linear chirp fromHz→toHz with a phase accumulator (a REAL sweep, not stitched sines). */
function sweep(fromHz: number, toHz: number, ms: number, sampleRate = SR, amp = 0.8): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = fromHz + ((toHz - fromHz) * i) / n;
    phase += (2 * Math.PI * hz) / sampleRate;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

function noise(ms: number, seed: number, sampleRate = SR, amp = 0.5): Float32Array {
  const rnd = mulberry32(seed);
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rnd() * 2 - 1);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** BIT-identity: every field Object.is-equal (catches -0 and NaN drift, unlike ===). */
function expectBitIdentical(opt: PitchResult, ref: PitchResult): void {
  expect(Object.is(opt.hz, ref.hz), `hz ${opt.hz} vs ${ref.hz}`).toBe(true);
  expect(Object.is(opt.clarity, ref.clarity), `clarity ${opt.clarity} vs ${ref.clarity}`).toBe(true);
  expect(Object.is(opt.rms, ref.rms), `rms ${opt.rms} vs ${ref.rms}`).toBe(true);
}

function expectPitchIdentical(win: Float32Array, sampleRate = SR, minHz = 110, maxHz = 1200, rmsGate = 0): void {
  expectBitIdentical(detectPitchHz(win, sampleRate, minHz, maxHz, rmsGate), detectPitchHzReference(win, sampleRate, minHz, maxHz, rmsGate));
}

/** Hop across a clip exactly like analyzeAudio does, asserting bit-identity per window. */
function expectClipIdentical(pcm: Float32Array, winLen: number, hop: number, rmsGate = 0): number {
  let windows = 0;
  for (let start = 0; start + winLen <= pcm.length; start += hop) {
    expectPitchIdentical(pcm.subarray(start, start + winLen), SR, 110, 1200, rmsGate);
    windows++;
  }
  return windows;
}

describe("detectPitchHz is bit-identical to the verbatim reference", () => {
  const winLen = Math.round(0.046 * SR); // analyzeAudio's default 46ms window
  const hop = Math.round(0.02 * SR); // render.ts --music hop (20ms)

  it("sine sweep 110->1200Hz, hopped like analyzeAudio (subarray windows)", () => {
    const clip = sweep(110, 1200, 800);
    expect(expectClipIdentical(clip, winLen, hop)).toBeGreaterThan(30);
  });

  it("pure tones across the searched range, several sample rates + amplitudes", () => {
    for (const sr of [22050, 44100, 48000]) {
      for (const hz of [110, 220, 440, 987, 1200]) {
        for (const amp of [0.9, 0.05, 1e-5]) {
          const win = sine(hz, 50, sr, amp);
          expectBitIdentical(detectPitchHz(win, sr, 110, 1200), detectPitchHzReference(win, sr, 110, 1200));
        }
      }
    }
  });

  it("noise, silence, and near-silence (rms < 1e-7) windows", () => {
    expectPitchIdentical(noise(50, 0xbeef));
    expectPitchIdentical(new Float32Array(winLen)); // exact silence
    expectPitchIdentical(sine(440, 50, SR, 1e-8)); // below the 1e-7 rms floor
  });

  it("rmsGate above and below the window rms (the goal-067 early-out is not regressed)", () => {
    const quiet = sine(440, 50, SR, 0.1);
    expectPitchIdentical(quiet, SR, 110, 1200, 0.2); // gate above rms -> early bail path
    expectPitchIdentical(quiet, SR, 110, 1200, 0.01); // gate below rms -> full search path
  });

  it("impulse/click windows (denom degenerate for most lags -> the skip path)", () => {
    const click = new Float32Array(winLen);
    click[0] = 1; // all energy in sample 0: e1 = 0 for every lag >= 1 -> denom <= 1e-12
    expectPitchIdentical(click);
    const click3 = new Float32Array(winLen);
    click3[0] = 0.5;
    click3[1] = -0.9;
    click3[2] = 0.7; // energy confined to the first 3 samples
    expectPitchIdentical(click3);
    // energy at the TAIL instead: e0 = sq[n-lag] degenerate for large lags
    const tail = new Float32Array(winLen);
    tail[winLen - 1] = 0.8;
    tail[winLen - 2] = -0.6;
    expectPitchIdentical(tail);
  });

  it("degenerate shapes: n < 4, maxLag <= minLag, DC-only window", () => {
    expectPitchIdentical(new Float32Array(0));
    expectPitchIdentical(Float32Array.from([0.5, -0.5, 0.5]));
    // minHz far above maxHz -> maxLag (23) <= minLag (441) -> early return after the prefix sums
    expectPitchIdentical(sine(440, 50), SR, 2000, 100);
    const dc = new Float32Array(winLen).fill(0.25);
    expectPitchIdentical(dc);
  });

  it("scratch reuse: a big-window call then smaller windows still match a fresh reference", () => {
    // grows the module scratch, leaving stale prefix sums beyond every later n - the sq[0]=0
    // re-zero and the 1..n overwrite must make all later calls independent of history
    detectPitchHz(sweep(110, 1200, 400), SR, 110, 1200);
    const clip = concat(sine(330, 120), noise(60, 7), sine(880, 120));
    expect(expectClipIdentical(clip, winLen, hop)).toBeGreaterThan(5);
    expectPitchIdentical(Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5])); // tiny n after big n
  });
});

// Same-run interleaved A/B (same protocol as the voxel perf tests): ref/opt ORDER alternates each
// round so whoever runs second inherits the first's GC debt equally; compare MEDIANS so a stray
// GC/scheduler spike cannot poison the result; retry so a false failure needs a hostile phase
// across every attempt while a real regression fails them all.
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

describe("detectPitchHz perf (same-run interleaved A/B vs the verbatim reference)", () => {
  const winLen = Math.round(0.046 * SR);
  const hop = Math.round(0.02 * SR);

  it("no regression hopping a fully-voiced 2s clip (the O(n*maxLag) dot products dominate)", { retry: 2, timeout: 120000 }, () => {
    // the analyzeAudio-shaped workload: 46ms windows every 20ms over sweep+tone+noise, all voiced,
    // so every hop pays the full pitch search. HONEST FINDING: on this path the D20 gates are
    // wall-time-neutral (measured 0.94-1.16x across runs - the dot products dominate and V8 already
    // handles the `i + lag < n` bound; the scratch buffer removes ~16KB/call of allocator churn
    // that a median can't see). The measurable wall win lives on the transient path below. This
    // gate exists to prove the voiced path did NOT regress.
    const clip = concat(sweep(110, 1200, 900), sine(440, 600), noise(500, 0x5eed));
    const batch = (fn: typeof detectPitchHz): number => {
      let acc = 0;
      for (let start = 0; start + winLen <= clip.length; start += hop) {
        acc += fn(clip.subarray(start, start + winLen), SR, 110, 1200).hz;
      }
      return acc;
    };
    // bit identity on the timed workload + JIT warmup
    expect(batch(detectPitchHz)).toBe(batch(detectPitchHzReference));
    const { refMs, optMs } = timedAB(() => batch(detectPitchHzReference), () => batch(detectPitchHz), 12);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    // parity within noise; generous floor so a busy CI box cannot flake the gate
    expect(refMs / optMs).toBeGreaterThanOrEqual(0.8);
  });

  it("hot-loop gate: skips the O(n*maxLag) dot products on transient windows (degenerate denom) >=2x", { retry: 2, timeout: 120000 }, () => {
    // percussive/click windows: ALL energy in the first samples of each (non-overlapping) window,
    // so the trailing half-window energy e1 = totalEnergy - sq[lag] is EXACTLY 0 for every lag ->
    // denom <= 1e-12 -> the optimized loop skips every dot product while the reference pays all
    // ~366 of them (~660k mult-adds per window) before discarding corr. Measured ~200x locally;
    // conservative >=2x floor so a busy CI box cannot flake the gate.
    const windows = 21;
    const clip = new Float32Array(windows * winLen);
    for (let k = 0; k < windows; k++) {
      clip[k * winLen] = k % 2 ? 0.9 : -0.9; // single click AT the window start
      clip[k * winLen + 1] = 0.4;
    }
    const batch = (fn: typeof detectPitchHz): number => {
      let acc = 0;
      for (let start = 0; start + winLen <= clip.length; start += winLen) {
        acc += fn(clip.subarray(start, start + winLen), SR, 110, 1200).clarity;
      }
      return acc;
    };
    expect(batch(detectPitchHz)).toBe(batch(detectPitchHzReference));
    const { refMs, optMs } = timedAB(() => batch(detectPitchHzReference), () => batch(detectPitchHz), 12);
    expect(optMs).toBeGreaterThan(0);
    expect(refMs).toBeGreaterThan(0);
    expect(refMs / optMs).toBeGreaterThanOrEqual(2);
  });
});
