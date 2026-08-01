// Original-soundtrack playback for an imported clip, kept in sync with the block-animation frame
// clock. The imported video File is loaded into an HTMLAudioElement (the browser plays the audio
// track of a video container natively); the viewer's onFrame callback drives sync: each shown
// frame maps to its clip time through the SAME per-frame durations the viewer plays by, and the
// audio element is resnapped whenever it drifts past a small tolerance (covers scrubs, loop wrap,
// pauses, and slow decode stalls in one rule). The math is pure and unit-tested; only the thin
// element glue is browser-only.

/** Cumulative start time (seconds) of every frame, from per-frame durations (ms). Frames with an
 *  unknown duration take `fallbackMs` (matches the viewer's uniform fallback). Pure. */
export function timelineStarts(durationsMs: ReadonlyArray<number | undefined | null>, fallbackMs = 100): Float64Array {
  const starts = new Float64Array(durationsMs.length);
  let acc = 0;
  for (let i = 0; i < durationsMs.length; i++) {
    starts[i] = acc;
    const d = durationsMs[i];
    acc += (typeof d === "number" && d > 0 ? d : fallbackMs) / 1000;
  }
  return starts;
}

/** Clip time (seconds) at which frame `frame` begins. Out-of-range frames clamp. Pure. */
export function clipTimeOf(starts: Float64Array, frame: number): number {
  if (starts.length === 0) return 0;
  const i = Math.min(starts.length - 1, Math.max(0, Math.floor(frame)));
  return starts[i]!;
}

/** True when the audio clock has drifted from the frame clock far enough to resnap. The tolerance
 *  is deliberately larger than one frame at any supported fps (16-100 ms) so sync corrections are
 *  rare clicks, not a per-frame stutter - but small enough that lips/beats stay locked. Pure. */
export function needsResnap(audioTimeSec: number, targetSec: number, tolSec = 0.3): boolean {
  return Math.abs(audioTimeSec - targetSec) > tolSec;
}

export type ClipAudioMode = "original" | "noteblocks" | "mute";

/** Browser glue: owns the HTMLAudioElement + object URL for the active clip. Safe no-op outside a
 *  browser (jsdom) and when no clip is loaded. */
export class ClipAudio {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private starts: Float64Array = new Float64Array(0);
  private mode: ClipAudioMode = "original";
  /** Fired when the browser's autoplay policy rejects play() - the host surfaces it (the
   *  rejection used to be swallowed silently, leaving the user with mysteriously mute audio). */
  onAutoplayBlocked?: () => void;

  /** Adopt a freshly-imported clip + its per-frame timing (replaces any previous clip). */
  load(file: File, durationsMs: ReadonlyArray<number | undefined | null>): void {
    this.dispose();
    if (typeof Audio === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
    this.starts = timelineStarts(durationsMs);
    this.url = URL.createObjectURL(file);
    this.el = new Audio(this.url);
    this.el.preload = "auto";
  }

  setMode(mode: ClipAudioMode): void {
    this.mode = mode;
    if (mode !== "original") this.el?.pause();
  }
  get currentMode(): ClipAudioMode {
    return this.mode;
  }
  get hasClip(): boolean {
    return this.el !== null;
  }

  /** Drive sync from the viewer's frame clock. Call on every shown frame (and on pause with
   *  `playing=false`). Resnaps on drift/scrub/wrap; starts playback lazily inside the page's
   *  user-activation (the play button click that started the viewer). */
  frameShown(frame: number, playing: boolean): void {
    const el = this.el;
    if (!el || this.mode !== "original") return;
    if (!playing) {
      el.pause();
      return;
    }
    const t = clipTimeOf(this.starts, frame);
    if (el.paused) {
      el.currentTime = t;
      // autoplay-policy rejection: stay silent until the next gesture, but SAY so
      void el.play().catch(() => this.onAutoplayBlocked?.());
      return;
    }
    if (needsResnap(el.currentTime, t)) el.currentTime = t;
  }

  pause(): void {
    this.el?.pause();
  }

  /** Release the element + object URL (new import / teardown). Safe to call repeatedly. */
  dispose(): void {
    if (this.el) {
      this.el.pause();
      this.el.src = "";
      this.el = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.starts = new Float64Array(0);
  }
}
