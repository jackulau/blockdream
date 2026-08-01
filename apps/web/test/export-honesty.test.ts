import { describe, it, expect } from "vitest";
import { planGifExport, gifFrameDelays, packingHudText, reportPngDownload, GIF_EXPORT_PIXEL_BUDGET } from "../src/export-plan";
import { planExportBudget, planTickPlayback, EXPORT_FRAME_BUDGET } from "../src/datapack-export";
import { clampFrameDurations, MIN_FRAME_MS } from "../src/anim";

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

describe("gifFrameDelays (goal 088 D9b: GIF pacing == in-game tick-plan pacing)", () => {
  it("no timing uses the tick plan's uniform dwell (2 ticks = 100 ms), not the old 70 ms", () => {
    const plan = planTickPlayback(3, null);
    expect(plan.speedTicks).toBe(2);
    expect(gifFrameDelays(3, null)).toEqual([100, 100, 100]);
    expect(gifFrameDelays(3, null)[0]).toBe(plan.speedTicks * 50);
  });

  it("real per-frame timing survives, with the 100 ms tick-plan fallback filling gaps", () => {
    expect(gifFrameDelays(3, [40, 0, undefined])).toEqual([40, 100, 100]);
  });

  it("sub-floor delays are clamped by the SAME MIN_FRAME_MS the viewer clock uses", () => {
    expect(gifFrameDelays(2, [2, 60])).toEqual([MIN_FRAME_MS, 60]);
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
