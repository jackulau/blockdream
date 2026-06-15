// Variable-rate frame-playback clock. Maps elapsed wall-clock time to a frame index
// using per-frame durations - so an animated GIF plays at its REAL speed (each frame can
// have its own delay) instead of a single hardcoded fps. Pure + DOM-free, so it is unit-
// tested without a browser (jsdom can't run ImageDecoder/WebGL, but this is just math).

export interface FrameSchedule {
  /** cumulative END time (ms) of each frame: cumulative[i] = sum(durations[0..i]). */
  readonly cumulative: number[];
  /** total loop duration (ms). */
  readonly total: number;
  /** number of frames. */
  readonly count: number;
}

/** Guard against pathological 0-delay GIF frames pinning playback to a single tick. */
export const MIN_FRAME_MS = 10;

/** Build a playback schedule from per-frame durations (ms). Missing/<=0 → fallbackMs. */
export function buildSchedule(durationsMs: Array<number | undefined | null>, fallbackMs = 100): FrameSchedule {
  const cumulative: number[] = [];
  let acc = 0;
  for (const d of durationsMs) {
    const dur = d != null && d > 0 ? Math.max(MIN_FRAME_MS, d) : fallbackMs;
    acc += dur;
    cumulative.push(acc);
  }
  return { cumulative, total: acc, count: durationsMs.length };
}

/** Uniform schedule at a fixed fps - the fallback when there are no per-frame durations. */
export function uniformSchedule(count: number, fps: number): FrameSchedule {
  return buildSchedule(new Array(count).fill(1000 / Math.max(1, fps)));
}

/**
 * Frame index to show at `elapsedMs` since playback started. Loops over the total
 * duration by default. Uses binary search over the cumulative ends, so it is O(log n)
 * and frame-rate independent (the same elapsed time always yields the same frame).
 */
export function frameAtElapsed(schedule: FrameSchedule, elapsedMs: number, loop = true): number {
  const { cumulative, total, count } = schedule;
  if (count <= 1 || total <= 0) return 0;
  let t = elapsedMs;
  if (loop) t = ((t % total) + total) % total;
  else if (t >= total) return count - 1;
  else if (t < 0) return 0;
  // first frame whose cumulative end is strictly greater than t
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Elapsed-ms offset at which frame `i` begins (cumulative end of the previous frame). */
export function startOfFrame(schedule: FrameSchedule, i: number): number {
  if (i <= 0) return 0;
  const clamped = Math.min(i, schedule.count) - 1;
  return schedule.cumulative[clamped] ?? schedule.total;
}
