// WebAudio note-block preview - hear the transcribed note-block line IN THE BROWSER, in sync
// with the playing block animation, before ever loading the datapack in-game. The voice is a
// plucked triangle with an exponential decay - close enough to the in-game harp to judge the
// melody and timing. Scheduling is frame-windowed: the viewer's playback clock is wall-clock
// anchored, so scheduling each frame's notes as its frame is shown keeps audio and blocks in
// step for arbitrarily long clips (jitter ≤ one raf, well under the 50 ms tick resolution).
import type { NoteEvent } from "@blockdream/audio";
import { noteBlockPitch } from "@blockdream/audio";

/** Note-block harp base sample pitch (F#4). In-game `playsound` multiplies this by noteBlockPitch. */
export const HARP_BASE_HZ = 369.994;

/** Notes whose tick falls inside the half-open tick window [t0, t1). Pure. */
export function notesForWindow(events: NoteEvent[], t0: number, t1: number): NoteEvent[] {
  return events.filter((e) => e.tick >= t0 && e.tick < t1);
}

/** Notes whose tick falls inside frame `frame`'s window [frame*tpf, (frame+1)*tpf). Pure. */
export function notesForFrame(events: NoteEvent[], frame: number, ticksPerFrame: number): NoteEvent[] {
  const t0 = frame * ticksPerFrame;
  return notesForWindow(events, t0, t0 + ticksPerFrame);
}

/**
 * Tick window [t0, t1) that source frame `frame` occupies on the PACK's tick clock, derived
 * from the SAME tick plan the datapack export uses (planTickPlayback). Kept frames own their
 * whole dwell (speedTicks ticks); a frame the plan skipped (resampled >20 fps clip) gets an
 * empty window - its pack ticks belong to the surrounding kept frames. The union of windows
 * over all source frames is exactly [0, keptFrames × speedTicks), i.e. the pack's music loop
 * (datapack3d locks #mtcount to frames × speed), so the preview inherits the pack's loop trim:
 * a note past the loop never previews, because no window ever reaches it. Pure.
 */
export function previewTickWindow(
  plan: { indices: ReadonlyArray<number>; speedTicks: number },
  frame: number,
): { t0: number; t1: number } {
  // first plan slot showing a source frame >= `target` (indices is non-decreasing)
  const lowerBound = (target: number): number => {
    const a = plan.indices;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { t0: lowerBound(frame) * plan.speedTicks, t1: lowerBound(frame + 1) * plan.speedTicks };
}

/** Audible frequency of a note-block note index (0..24), Hz. Pure. */
export function noteHz(note: number): number {
  return HARP_BASE_HZ * noteBlockPitch(note);
}

export class NotePreview {
  private ctx: AudioContext | null = null;
  private events: NoteEvent[] = [];
  private enabled = true;
  /** Fired when the AudioContext is suspended by the autoplay policy (notes stay silent this
   *  frame) - the host surfaces it instead of the old silent swallow. */
  onAutoplayBlocked?: () => void;

  setEvents(events: NoteEvent[]): void {
    this.events = events;
  }
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /**
   * Schedule the notes of one animation frame's tick window [t0, t1) on the pack's tick
   * clock (50 ms/tick). Call from the viewer's onFrame while playing - the AudioContext is
   * created lazily on the first call, which happens inside the user's play-button gesture
   * (autoplay policy satisfied). The host derives the window from the SAME tick plan the
   * datapack export uses (previewTickWindow), so what previews is what the pack plays.
   */
  windowShown(t0: number, t1: number): void {
    if (t1 <= t0) return; // a frame the tick plan skipped owns no ticks - nothing to play
    if (!this.enabled || !this.events.length) return;
    if (typeof AudioContext === "undefined") return; // jsdom / headless: preview is a no-op
    const ctx = (this.ctx ??= new AudioContext());
    if (ctx.state !== "running") {
      // suspended until a user gesture (autoplay policy): do NOT schedule - oscillators queued
      // into a suspended context all fire at once on resume (a blast of stale notes). Ask to
      // resume, say so, and stay silent this frame; scheduling starts once it runs.
      void ctx.resume();
      this.onAutoplayBlocked?.();
      return;
    }
    const now = ctx.currentTime;
    for (const e of notesForWindow(this.events, t0, t1)) {
      const at = now + (e.tick - t0) * 0.05;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = noteHz(e.note);
      gain.gain.setValueAtTime(0.22, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.75);
    }
  }

  /** Legacy uniform-window entry point: frame `frame` at `ticksPerFrame` ticks per frame. */
  frameShown(frame: number, ticksPerFrame: number): void {
    const t0 = frame * ticksPerFrame;
    this.windowShown(t0, t0 + ticksPerFrame);
  }

  /** Release the audio device (new import / teardown). Safe to call repeatedly. */
  stop(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
