import { describe, it, expect } from "vitest";
import { planGifExport, gifExportPacing, packingHudText, reportPngDownload, GIF_EXPORT_PIXEL_BUDGET } from "../src/export-plan";
import { planExportBudget, planTickPlayback, EXPORT_FRAME_BUDGET } from "../src/datapack-export";
import { clampFrameDurations, MIN_FRAME_MS } from "../src/anim";
import { musicKeyboardHalf } from "../src/canvas-mod";
import { noteSequencer } from "@blockdream/emit-commands";
import type { NoteEvent } from "@blockdream/audio";

// Export honesty (goal 087 D8): the download buttons must not claim success over a failed
// encode, and heavy exports must be budgeted + announced BEFORE the synchronous work starts.
// The decisions live in the pure export-plan module so the ordering is testable here; the
// showcase handlers call planGifExport / packingHudText FIRST, then setTimeout into the encode.

describe("planGifExport (hard memory cap, decided before any raster is allocated)", () => {
  // 128×96 blocks → fitScale(...,384) = 3 → 384×288 px per frame
  const frame = { sx: 128, sy: 96 };
  const pixelsPerFrame = 384 * 288;

  it("a normal clip is within budget and announces the encode", () => {
    const plan = planGifExport(Array.from({ length: 240 }, () => frame));
    expect(plan.ok).toBe(true);
    expect(plan.outWidth).toBe(384);
    expect(plan.outHeight).toBe(288);
    expect(plan.message).toContain("encoding 240 GIF frames");
  });

  it("refuses exactly past the pixel budget (boundary from the math, not a magic frame count)", () => {
    const maxFrames = Math.floor(GIF_EXPORT_PIXEL_BUDGET / pixelsPerFrame);
    expect(planGifExport(Array.from({ length: maxFrames }, () => frame)).ok).toBe(true);
    const over = planGifExport(Array.from({ length: maxFrames + 1 }, () => frame));
    expect(over.ok).toBe(false);
    expect(over.maxFrames).toBe(maxFrames);
  });

  it("the worst case that killed the tab (13200 frames at 60 fps) is refused with the math", () => {
    const plan = planGifExport(Array.from({ length: 13200 }, () => ({ sx: 160, sy: 120 })));
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain("GIF export refused");
    expect(plan.message).toContain("13200 frames");
    expect(plan.message).toMatch(/~\d+ MB/); // says the actual memory it would take
    expect(plan.message).toContain(`${plan.maxFrames} frames`); // and what WOULD fit
  });

  it("mixed frame sizes budget by the padded (max) size, like the encoder pads", () => {
    const plan = planGifExport([
      { sx: 64, sy: 64 },
      { sx: 128, sy: 96 },
    ]);
    expect(plan.outWidth).toBe(384); // padded to 128×96, then ×3
    expect(plan.outHeight).toBe(288);
    expect(plan.totalPixels).toBe(2 * pixelsPerFrame);
  });
});

describe("packingHudText (datapack warn goes to the HUD BEFORE generation)", () => {
  it("an over-budget frame count carries the warning in the pre-pack HUD line", () => {
    const budget = planExportBudget(EXPORT_FRAME_BUDGET + 400);
    expect(budget.warn).toBe(true);
    const hud = packingHudText(budget, EXPORT_FRAME_BUDGET + 400);
    expect(hud).toContain("WARNING");
    expect(hud).toContain(budget.message);
    expect(hud).toContain(`packing ${EXPORT_FRAME_BUDGET + 400} frames`);
  });

  it("a within-budget pack just says packing", () => {
    const hud = packingHudText(planExportBudget(120), 120);
    expect(hud).toBe("packing 120 frames into a datapack…");
    expect(hud).not.toContain("WARNING");
  });
});

describe("reportPngDownload (success text only after the encode resolves)", () => {
  it("a rejected download writes the failure into the status line, not the success text", async () => {
    const status = { textContent: "" as string | null };
    await reportPngDownload(Promise.reject(new Error("PNG encode failed")), status, "PNG: 512×512 px");
    expect(status.textContent).toBe("PNG export failed: PNG encode failed");
  });

  it("a resolved download writes the success text (and only then)", async () => {
    const status = { textContent: "" as string | null };
    const report = reportPngDownload(
      new Promise<void>((res) => setTimeout(res, 5)),
      status,
      "PNG: 512×512 px",
    );
    expect(status.textContent).toBe(""); // not yet - no premature success claim
    await report;
    expect(status.textContent).toBe("PNG: 512×512 px");
  });
});

// Goal 088 D9: GIF pacing must match the datapack's tick plan, an empty export must refuse,
// and every consumer of decoded timing shares ONE duration sanitizer (clampFrameDurations).

describe("planGifExport with zero frames (goal 088 D9d)", () => {
  it("an empty export is refused, not a degenerate 'encoding 0 frames' success", () => {
    const plan = planGifExport([]);
    expect(plan.ok).toBe(false);
    expect(plan.frames).toBe(0);
    expect(plan.message).toContain("no frames");
  });
});

describe("gifExportPacing (goal 089 D8: GIF frames + delays == the pack's tick plan)", () => {
  it("no timing uses the tick plan's uniform dwell (2 ticks = 100 ms) over every frame", () => {
    const plan = planTickPlayback(3, null);
    expect(plan.speedTicks).toBe(2);
    const pacing = gifExportPacing(3, null);
    expect(pacing.indices).toEqual([0, 1, 2]);
    expect(pacing.delayMs).toBe(plan.speedTicks * 50);
    expect(pacing.totalMs).toBe(300);
  });

  it("junk entries fall back to the plan's 100 ms default, matching the pack", () => {
    // [40, 0, undefined] plans as [40, 100, 100] → avg 80 ms → 2-tick dwell, every frame kept
    const pacing = gifExportPacing(3, [40, 0, undefined]);
    expect(pacing.indices).toEqual([0, 1, 2]);
    expect(pacing.delayMs).toBe(100);
    expect(pacing.totalMs).toBe(300);
  });

  it(">20 fps sources emit the pack's RESAMPLED frame list at the 50 ms tick dwell", () => {
    const pacing = gifExportPacing(3, [40, 40, 40]);
    const plan = planTickPlayback(3, [40, 40, 40]);
    expect(plan.resampled).toBe(true);
    expect(pacing.indices).toEqual(plan.indices); // the GIF shows exactly the pack's frames
    expect(pacing.delayMs).toBe(50);
    expect(pacing.totalMs).toBe(plan.indices.length * plan.speedTicks * 50);
  });
});

describe("clampFrameDurations (goal 088 D9e: one shared duration sanitizer)", () => {
  it("floors real durations at MIN_FRAME_MS and blanks junk so each consumer's fallback applies", () => {
    expect(clampFrameDurations([2, 60, 0, -5, undefined, null])).toEqual([
      MIN_FRAME_MS, 60, undefined, undefined, undefined, undefined,
    ]);
  });

  it("passes null through (no timing stays no timing)", () => {
    expect(clampFrameDurations(null)).toBeNull();
  });
});

describe("musicKeyboardHalf (goal 088 D3: center on the keyboard the pack ACTUALLY places)", () => {
  const ev = (tick: number, note: number, instrument = "harp"): NoteEvent => ({
    tick, note, instrument, velocity: 1,
  });

  it("counts distinct (instrument, note) PAIRS - the same note on two instruments is two cells", () => {
    const notes = [ev(0, 5, "harp"), ev(1, 5, "bass"), ev(2, 5, "harp")];
    // the old note-only Set guess said width 1 (half 0); the real keyboard is 2 cells wide
    expect(musicKeyboardHalf(notes, 1, 2)).toEqual({ x: 0.5, z: 0 });
  });

  it("respects the animation loop trim - notes past frameCount x speedTicks do not widen the row", () => {
    const notes = [ev(0, 1), ev(100, 2)]; // loop = 2 frames x 2 ticks = 4; tick 100 is trimmed
    expect(musicKeyboardHalf(notes, 2, 2)).toEqual({ x: 0, z: 0 });
    // a single still (frameCount 1) has no loop override, so both notes count
    expect(musicKeyboardHalf(notes, 1, 2)).toEqual({ x: 0.5, z: 0 });
  });

  it("matches the sequencer's own keyboardNotes for the same loop context", () => {
    const notes = [ev(0, 3), ev(1, 7), ev(2, 3, "bass"), ev(3, 12)];
    const seq = noteSequencer(notes, { placeKeyboard: false, loopTicksOverride: 8 });
    expect(musicKeyboardHalf(notes, 4, 2)).toEqual({ x: (seq.keyboardNotes - 1) / 2, z: 0 });
  });

  it("no notes -> zero extent (and no sequencer call blows up on empty input)", () => {
    expect(musicKeyboardHalf([], 10, 2)).toEqual({ x: 0, z: 0 });
  });
});
