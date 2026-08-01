import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gifExportPacing, tickPlanDurations } from "../src/export-plan";
import { planTickPlayback } from "../src/datapack-export";
import { previewTickWindow, notesForWindow, NotePreview } from "../src/note-preview";
import { MIN_FRAME_MS } from "../src/anim";
import type { NoteEvent } from "@blockdream/audio";

// Web pacing parity (goal 089 D8). Three measured divergences between what the page exports/
// previews and what the datapack actually plays:
//   (a) the GIF was built from UNRESAMPLED frames at per-frame source delays while the pack
//       plays the tick plan's (possibly resampled) list at a uniform speedTicks dwell -
//       [40,40,40] → GIF 120 ms vs pack 100 ms; [25,25] → GIF 50 ms vs pack 100 ms;
//   (b) the note preview windowed by round(rawDuration/50) per frame with NO loop trim, so a
//       30 fps import previewed the whole melody while the pack (music loop locked to
//       keptFrames × speedTicks in datapack3d) dropped the tail;
//   (c) durations were floored at MIN_FRAME_MS per frame BEFORE planTickPlayback, inflating
//       every >100 fps source (120 fps 1 s → a 1.20 s pack; the CLI plans on raw durations
//       and correctly emits 1.00 s).

/** The pack's in-game loop duration (ms) for a clip: kept frames × tick dwell. */
function packTotalMs(frameCount: number, durationsMs: Array<number | undefined | null> | null): number {
  const plan = planTickPlayback(frameCount, tickPlanDurations(durationsMs));
  return plan.indices.length * plan.speedTicks * 50;
}

describe("(a) GIF total == pack total for the measured cases", () => {
  it("[40,40,40] resamples: GIF = the pack's 2 frames × 50 ms = 100 ms (was 3 × 40 = 120)", () => {
    const pacing = gifExportPacing(3, [40, 40, 40]);
    expect(pacing.indices.length).toBe(2);
    expect(pacing.delayMs).toBe(50);
    expect(pacing.totalMs).toBe(100);
    expect(pacing.totalMs).toBe(packTotalMs(3, [40, 40, 40]));
  });

  it("[25,25] keeps both frames at the 1-tick dwell: GIF 100 ms == pack 100 ms (was 50)", () => {
    const pacing = gifExportPacing(2, [25, 25]);
    expect(pacing.indices).toEqual([0, 1]);
    expect(pacing.delayMs).toBe(50);
    expect(pacing.totalMs).toBe(100);
    expect(pacing.totalMs).toBe(packTotalMs(2, [25, 25]));
  });

  it("no timing (baked spin): 24 frames × 100 ms both ways", () => {
    const pacing = gifExportPacing(24, null);
    expect(pacing.indices.length).toBe(24);
    expect(pacing.delayMs).toBe(100);
    expect(pacing.totalMs).toBe(2400);
    expect(pacing.totalMs).toBe(packTotalMs(24, null));
  });

  it("property: GIF frame list and total match the pack's tick plan for arbitrary timings", () => {
    const cases: Array<[number, Array<number | undefined | null> | null]> = [
      [1, [500]],
      [5, [100, 200, 100, 50, 150]],
      [7, [16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7]],
      [10, [0, -3, undefined, null, 80, 80, 80, 80, 80, 80]],
      [48, Array.from({ length: 48 }, () => 33.4)],
    ];
    for (const [n, d] of cases) {
      const pacing = gifExportPacing(n, d);
      const plan = planTickPlayback(n, tickPlanDurations(d));
      expect(pacing.indices, `indices n=${n}`).toEqual(plan.indices);
      expect(pacing.delayMs, `delay n=${n}`).toBe(plan.speedTicks * 50);
      expect(pacing.totalMs, `total n=${n}`).toBe(plan.indices.length * plan.speedTicks * 50);
    }
  });

  it("showcase wires the GIF export through gifExportPacing over the pack's frame list", () => {
    const showcase = readFileSync(fileURLToPath(new URL("../src/showcase.ts", import.meta.url)), "utf8");
    expect(showcase).toContain("gifExportPacing(allFrames.length, durationsMs)");
    expect(showcase).toContain("pacing.indices.map((i) => allFrames[i]!)");
    expect(showcase).toContain("delayMs: pacing.delayMs");
    expect(showcase).not.toContain("gifFrameDelays"); // the per-frame source-delay path is gone
  });
});

describe("(b) note preview melody window == pack window", () => {
  // a 30 fps import: 30 frames at 33.4 ms → the pack resamples to 20 ticks (1.002 s)
  const durations = Array.from({ length: 30 }, () => 33.4);
  const plan = planTickPlayback(30, tickPlanDurations(durations));

  it("the per-frame windows tile [0, keptFrames × speedTicks) exactly - the pack's music loop", () => {
    expect(plan.resampled).toBe(true);
    const loopTicks = plan.indices.length * plan.speedTicks; // datapack3d locks #mtcount to this
    expect(loopTicks).toBe(20);
    let cursor = 0;
    for (let f = 0; f < 30; f++) {
      const w = previewTickWindow(plan, f);
      expect(w.t0, `frame ${f} starts where the previous ended`).toBe(cursor);
      expect(w.t1).toBeGreaterThanOrEqual(w.t0);
      cursor = w.t1;
    }
    expect(cursor).toBe(loopTicks); // no window ever reaches past the pack's loop trim
  });

  it("a note past the pack's loop trim never previews; one inside plays exactly once", () => {
    const events: NoteEvent[] = [
      { tick: 0, note: 4, instrument: "harp", velocity: 1 },
      { tick: 10, note: 12, instrument: "harp", velocity: 1 },
      { tick: 25, note: 20, instrument: "harp", velocity: 1 }, // beyond loopTicks 20 - pack drops it
    ];
    const seen: number[] = [];
    for (let f = 0; f < 30; f++) {
      const w = previewTickWindow(plan, f);
      for (const e of notesForWindow(events, w.t0, w.t1)) seen.push(e.tick);
    }
    expect(seen).toEqual([0, 10]);
  });

  it("at/below 20 fps every frame owns its whole uniform dwell (kept-frame parity)", () => {
    const uniform = planTickPlayback(3, tickPlanDurations([100, 100, 100]));
    expect(uniform.resampled).toBe(false);
    expect(uniform.speedTicks).toBe(2);
    expect(previewTickWindow(uniform, 0)).toEqual({ t0: 0, t1: 2 });
    expect(previewTickWindow(uniform, 1)).toEqual({ t0: 2, t1: 4 });
    expect(previewTickWindow(uniform, 2)).toEqual({ t0: 4, t1: 6 });
  });

  it("NotePreview.windowShown schedules exactly the window's notes at the 50 ms tick offset", () => {
    const starts: number[] = [];
    class FakeCtx {
      state = "running";
      currentTime = 0;
      destination = {};
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      createOscillator(): unknown {
        return {
          type: "",
          frequency: { value: 0 },
          connect: (g: unknown) => g,
          start: (at: number) => starts.push(at),
          stop: () => {},
        };
      }
      createGain(): unknown {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: () => ({}),
        };
      }
    }
    vi.stubGlobal("AudioContext", FakeCtx);
    try {
      const preview = new NotePreview();
      preview.setEvents([
        { tick: 0, note: 4, instrument: "harp", velocity: 1 },
        { tick: 10, note: 12, instrument: "harp", velocity: 1 },
        { tick: 25, note: 20, instrument: "harp", velocity: 1 },
      ]);
      for (let f = 0; f < 30; f++) {
        const w = previewTickWindow(plan, f);
        preview.windowShown(w.t0, w.t1);
      }
      // ticks 0 and 10 fire once each at their in-window offset (tick - t0 = 0 → at "now");
      // tick 25 is past the loop - never scheduled, matching the pack
      expect(starts).toEqual([0, 0]);
      preview.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("showcase drives the preview from the SAME tick plan, not per-frame rounded durations", () => {
    const showcase = readFileSync(fileURLToPath(new URL("../src/showcase.ts", import.meta.url)), "utf8");
    expect(showcase).toContain("previewTickWindow(previewPlan, i)");
    expect(showcase).toContain("notePreview.windowShown(w.t0, w.t1)");
    expect(showcase).not.toContain("notePreview.frameShown("); // the raw-duration guess is gone
  });
});

describe("(c) >100 fps sources plan at their REAL total, not a per-frame floored one", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tickPlanDurations sanitizes junk but never floors a real sub-10 ms duration", () => {
    expect(tickPlanDurations([8.33, 0, -2, undefined, null, 60])).toEqual([
      8.33, undefined, undefined, undefined, undefined, 60,
    ]);
    expect(tickPlanDurations(null)).toBeNull();
    expect(MIN_FRAME_MS).toBe(10); // the display floor that must NOT touch the plan input
  });

  it("a 120 fps 1 s source packs (and GIF-exports) at 1.00 s, matching the CLI", () => {
    const durations = Array.from({ length: 120 }, () => 1000 / 120);
    expect(packTotalMs(120, durations)).toBe(1000);
    expect(gifExportPacing(120, durations).totalMs).toBe(1000);
    // the old clamped path inflated the same source to 1.20 s
    const floored = durations.map((d) => Math.max(MIN_FRAME_MS, d));
    const oldPlan = planTickPlayback(120, floored);
    expect(oldPlan.indices.length * oldPlan.speedTicks * 50).toBe(1200);
  });

  it("the datapack export feeds planTickPlayback un-floored durations", () => {
    const showcase = readFileSync(fileURLToPath(new URL("../src/showcase.ts", import.meta.url)), "utf8");
    expect(showcase).toContain("planTickPlayback(allFrames.length, tickPlanDurations(durationsMs))");
    expect(showcase).not.toContain("clampFrameDurations("); // no per-frame floor before planning
  });
});
