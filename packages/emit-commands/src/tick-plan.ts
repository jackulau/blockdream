// Honest in-game playback planning. Minecraft executes one animation step per game tick
// (20 tps), so 20 fps is the physical playback ceiling for every tick-driven emitter -
// a pack cannot show frames faster, only skip them. Pure and browser-safe; shared by the
// web exporter and the CLI so both resample identically.

/** How a clip plays back IN GAME. */
export interface TickPlan {
  /** which source frames to emit (identity when nothing is skipped) */
  indices: number[];
  /** game ticks each emitted frame is held (1 tick = 50 ms) */
  speedTicks: number;
  /** resulting in-game frame rate */
  fps: number;
  /** true when the source was decoded above 20 fps and frames were evenly skipped */
  resampled: boolean;
}

/**
 * Plan honest in-game playback for `n` frames with real per-frame timing. At or below 20 fps every
 * frame is kept and dwells its nearest whole-tick duration. ABOVE 20 fps the plan resamples EVENLY
 * down to one frame per tick, so the in-game clip runs the same wall-clock duration as the source
 * (dropping detail, never stretching time). No timing (`durationsMs` null) keeps the legacy default
 * (2 ticks/frame = 10 fps), which is what baked spins/effect sequences have always used. Pure.
 */
export function planTickPlayback(n: number, durationsMs: ReadonlyArray<number | undefined | null> | null, fallbackMs = 100): TickPlan {
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n <= 1 || !durationsMs || !durationsMs.length) {
    return { indices: identity, speedTicks: 2, fps: 10, resampled: false };
  }
  let totalMs = 0;
  for (let i = 0; i < n; i++) {
    const d = durationsMs[i];
    totalMs += typeof d === "number" && d > 0 ? d : fallbackMs;
  }
  const avg = totalMs / n;
  if (avg >= 50) {
    const speedTicks = Math.max(1, Math.round(avg / 50));
    return { indices: identity, speedTicks, fps: 20 / speedTicks, resampled: false };
  }
  const target = Math.max(2, Math.round(totalMs / 50));
  if (target >= n) {
    // A tiny above-20fps clip (e.g. 2 frames at 25 ms) cannot be thinned below n
    // frames: the plan is the identity, nothing is skipped, and the in-game clip
    // runs n ticks (longer than the source). Claiming resampled here made the CLI
    // print "resampled 2 -> 2 frames ... same duration" while stretching time.
    return { indices: identity, speedTicks: 1, fps: 20, resampled: false };
  }
  const indices = Array.from({ length: target }, (_, i) => Math.min(n - 1, Math.floor((i * n) / target)));
  return { indices, speedTicks: 1, fps: 20, resampled: true };
}
