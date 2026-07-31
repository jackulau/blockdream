import { describe, it, expect } from "vitest";
import { planGifExport, packingHudText, reportPngDownload, GIF_EXPORT_PIXEL_BUDGET } from "../src/export-plan";
import { planExportBudget, EXPORT_FRAME_BUDGET } from "../src/datapack-export";

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
